import AppKit
import ApplicationServices
import AVFoundation
import CoreGraphics
import Darwin
import ImageIO
import ScreenCaptureKit
import Speech
import SwiftUI
import WebKit

@main
final class OnlyChatApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private static var singleInstanceLockFD: Int32 = -1
    private var window: NSWindow!
    private var webView: WKWebView!
    private var browserWebView: NSHostingView<AnyView>?
    private var serverProcess: Process?
    private var serverDiagnosticsHandle: FileHandle?
    private let port = (Bundle.main.object(forInfoDictionaryKey: "OnlyChatServerPort") as? Int)
        ?? Int(ProcessInfo.processInfo.environment["ONLY_CHAT_PORT"] ?? "") ?? 8899
    private let audioEngine = AVAudioEngine()
    private var speechTask: SFSpeechRecognitionTask?
    private var speechRequest: SFSpeechAudioBufferRecognitionRequest?
    private var speechTapInstalled = false
    private var speechStartRequested = false
    private var speechStartGeneration: UInt64 = 0

    static func main() {
        if let bundleIdentifier = Bundle.main.bundleIdentifier,
           let existing = NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
            .first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier && !$0.isTerminated }) {
            _ = existing.activate(options: [.activateAllWindows])
            exit(EXIT_SUCCESS)
        }
        guard claimSingleInstanceLock() else { exit(EXIT_SUCCESS) }
        let app = NSApplication.shared
        let delegate = OnlyChatApp()
        app.delegate = delegate
        app.setActivationPolicy(.regular)
        app.run()
    }

    private static func claimSingleInstanceLock() -> Bool {
        let lockURL = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("com.rogan.onlychat.single-instance-\(getuid()).lock")
        let descriptor = open(lockURL.path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, mode_t(S_IRUSR | S_IWUSR))
        guard descriptor >= 0 else { return false }

        var metadata = stat()
        guard fstat(descriptor, &metadata) == 0,
              metadata.st_uid == getuid(),
              (metadata.st_mode & S_IFMT) == S_IFREG,
              (metadata.st_mode & 0o077) == 0 else {
            close(descriptor)
            return false
        }

        let deadline = Date().addingTimeInterval(5)
        while true {
            if flock(descriptor, LOCK_EX | LOCK_NB) == 0 {
                singleInstanceLockFD = descriptor
                return true
            }
            let lockError = errno
            guard lockError == EWOULDBLOCK || lockError == EAGAIN else {
                close(descriptor)
                return false
            }
            if let existing = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
                .first(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier && !$0.isTerminated }) {
                _ = existing.activate(options: [.activateAllWindows])
                close(descriptor)
                return false
            }
            guard Date() < deadline else {
                close(descriptor)
                return false
            }
            usleep(50_000)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController.add(self, name: "speech")
        configuration.userContentController.add(self, name: "browserPanel")
        configuration.userContentController.add(self, name: "macScreen")
        configuration.userContentController.addUserScript(WKUserScript(
            source: """
            (() => {
              const key = 'onlyChatFontScale';
              const apply = () => {
                const scale = Number(localStorage.getItem(key));
                if (Number.isFinite(scale) && scale >= 0.75 && scale <= 2) document.documentElement.style.zoom = String(scale);
              };
              apply();
              document.addEventListener('keydown', event => {
                if (!event.ctrlKey || event.altKey || event.metaKey) return;
                const up = event.key === '+' || event.code === 'NumpadAdd' || (event.key === '=' && event.shiftKey);
                const down = event.key === '-' || event.code === 'Minus' || event.code === 'NumpadSubtract';
                if (!up && !down) return;
                event.preventDefault();
                event.stopPropagation();
                const current = Number(localStorage.getItem(key)) || 1;
                const next = Math.min(2, Math.max(0.75, Math.round((current + (up ? 0.1 : -0.1)) * 10) / 10));
                localStorage.setItem(key, String(next));
                document.documentElement.style.zoom = String(next);
              }, true);
            })();
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 850),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Only Chat"
        window.minSize = NSSize(width: 900, height: 620)
        window.center()
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.loadHTMLString(
            "<html><body style='font:16px -apple-system;display:grid;place-items:center;height:90vh;color:#555'>Only Chat 시작 중…</body></html>",
            baseURL: nil
        )
        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopSpeech()
        if let process = serverProcess, process.isRunning {
            process.terminate()
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "browserPanel" {
            handleBrowserPanelMessage(message.body)
            return
        }
        if message.name == "macScreen" {
            handleMacScreenMessage(message)
            return
        }
        guard message.name == "speech", let action = message.body as? String else { return }
        if action == "stop" { stopSpeech(); return }
        guard action == "start", !speechStartRequested else { return }
        speechStartRequested = true
        speechStartGeneration &+= 1
        let generation = speechStartGeneration
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self, self.speechStartRequested, self.speechStartGeneration == generation else { return }
                guard status == .authorized else { self.speechError("음성 인식 권한이 허용되지 않았습니다.", generation: generation); return }
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    DispatchQueue.main.async {
                        guard self.speechStartRequested, self.speechStartGeneration == generation else { return }
                        guard granted else { self.speechError("마이크 권한이 허용되지 않았습니다.", generation: generation); return }
                        self.startSpeech(generation: generation)
                    }
                }
            }
        }
    }

    private func handleBrowserPanelMessage(_ body: Any) {
        guard let message = body as? [String: Any], let action = message["action"] as? String else { return }
        switch action {
        case "layout":
            guard let rect = message["rect"] as? [String: CGFloat],
                  let x = rect["x"], let y = rect["y"], let width = rect["width"], let height = rect["height"],
                  width >= 0, height >= 0, width < 5000, height < 5000 else { return }
            let browser = ensureBrowserWebView()
            let frameY = webView.isFlipped ? y : webView.bounds.height - y - height
            browser.frame = NSRect(x: x, y: frameY, width: width, height: height)
            browser.isHidden = message["visible"] as? Bool != true || width < 1 || height < 1
        case "navigate":
            guard let value = message["url"] as? String, let url = Self.validBrowserURL(value) else { return }
            _ = ensureBrowserWebView()
            ThreeFEmbeddedBrowserSession.shared.navigate(to: url)
        case "back", "forward", "reload":
            _ = ThreeFEmbeddedBrowserSession.shared.history(action)
        case "read", "aria":
            _ = ensureBrowserWebView()
            if action == "read" {
                ThreeFEmbeddedBrowserSession.shared.readText { [weak self] value, error in
                    self?.sendBrowserResult(action: action, text: value ?? "", error: error ?? "")
                }
            } else {
                ThreeFEmbeddedBrowserSession.shared.accessibilityTree { [weak self] value, error in
                    self?.sendBrowserResult(action: action, text: value ?? "", error: error ?? "")
                }
            }
        case "act":
            guard let value = message["value"] as? String else { return }
            _ = ensureBrowserWebView()
            ThreeFEmbeddedBrowserSession.shared.act(value) { [weak self] result, error in
                self?.sendBrowserResult(action: "act", text: result ?? "", error: error ?? "")
            }
        case "status":
            sendAgentBrowserResult(id: message["id"] as? String, result: ThreeFEmbeddedBrowserSession.shared.status())
        case "agent":
            guard let command = message["command"] as? [String: Any],
                  let id = command["id"] as? String,
                  let operation = command["action"] as? String else { return }
            _ = ensureBrowserWebView()
            performAgentBrowserCommand(operation, command: command, id: id)
        default: break
        }
    }

    private func performAgentBrowserCommand(_ action: String, command: [String: Any], id: String) {
        let session = ThreeFEmbeddedBrowserSession.shared
        switch action {
        case "navigate":
            guard let value = command["url"] as? String, let url = Self.validBrowserURL(value) else {
                sendAgentBrowserResult(id: id, result: ["error": "유효한 HTTP 또는 HTTPS 주소가 필요합니다."])
                return
            }
            session.navigate(to: url)
            sendAgentBrowserResult(id: id, result: ["url": url.absoluteString, "text": "3F Browser 이동 요청을 보냈습니다."])
        case "back", "forward", "reload":
            let succeeded = session.history(action)
            sendAgentBrowserResult(id: id, result: succeeded ? ["url": session.status()["url"] ?? "", "text": "완료"] : ["error": "3F Browser 탐색 동작을 실행할 수 없습니다."])
        case "read":
            session.readText { [weak self] value, error in
                self?.sendAgentBrowserResult(id: id, result: ["text": value ?? "", "error": error ?? ""])
            }
        case "aria":
            session.accessibilityTree { [weak self] value, error in
                self?.sendAgentBrowserResult(id: id, result: ["text": value ?? "", "error": error ?? ""])
            }
        case "act":
            guard let value = command["value"] as? String else {
                sendAgentBrowserResult(id: id, result: ["error": "브라우저 동작 값이 필요합니다."])
                return
            }
            session.act(value) { [weak self] result, error in
                self?.sendAgentBrowserResult(id: id, result: ["text": result ?? "", "error": error ?? ""])
            }
        case "status": sendAgentBrowserResult(id: id, result: session.status())
        default: sendAgentBrowserResult(id: id, result: ["error": "지원하지 않는 3F Browser 명령입니다."])
        }
    }

    private func sendAgentBrowserResult(id: String?, result: [String: Any]) {
        guard let id,
              let data = try? JSONSerialization.data(withJSONObject: [id, result]),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async {
            self.webView.evaluateJavaScript("window.onlyChatBrowserCommandComplete && window.onlyChatBrowserCommandComplete(\(json)[0], \(json)[1])")
        }
    }

    private func handleMacScreenMessage(_ message: WKScriptMessage) {
        let source = webView.url
        guard message.frameInfo.isMainFrame, source?.scheme == "http",
              ["127.0.0.1", "localhost"].contains(source?.host ?? ""), source?.port == port else { return }
        guard let payload = message.body as? [String: Any], let id = payload["id"] as? String,
              let action = payload["action"] as? String else { return }
        let input = payload["input"] as? [String: Any] ?? [:]
        switch action {
        case "permissions":
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            let accessibility = AXIsProcessTrustedWithOptions(options)
            _ = CGRequestScreenCaptureAccess()
            sendMacScreenResult(id: id, result: macScreenPermissionStatus(accessibility: accessibility))
        case "status":
            sendMacScreenResult(id: id, result: macScreenPermissionStatus(accessibility: AXIsProcessTrusted()))
        case "capture":
            guard CGPreflightScreenCaptureAccess() else {
                sendMacScreenResult(id: id, result: ["error": "화면 기록 권한이 없습니다. Only Chat 설정에서 권한 요청을 눌러 주세요."])
                return
            }
            guard #available(macOS 14.0, *) else {
                sendMacScreenResult(id: id, result: ["error": "Mac 화면 캡처는 macOS 14 이상이 필요합니다."])
                return
            }
            Task { [weak self] in
                do {
                    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                    guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
                        self?.sendMacScreenResult(id: id, result: ["error": "캡처할 디스플레이를 찾지 못했습니다."])
                        return
                    }
                    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
                    let configuration = SCStreamConfiguration()
                    configuration.width = display.width
                    configuration.height = display.height
                    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
                    let rep = NSBitmapImageRep(cgImage: image)
                    guard let bytes = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.68]) else {
                        self?.sendMacScreenResult(id: id, result: ["error": "Mac 화면을 인코딩하지 못했습니다."])
                        return
                    }
                    self?.sendMacScreenResult(id: id, result: ["image": bytes.base64EncodedString(), "mimeType": "image/jpeg", "width": image.width, "height": image.height])
                } catch {
                    self?.sendMacScreenResult(id: id, result: ["error": "macOS 화면 캡처 실패: \(error.localizedDescription)"])
                }
            }
        case "click":
            guard AXIsProcessTrusted() else { sendMacScreenResult(id: id, result: ["error": "마우스 제어를 위해 macOS 손쉬운 사용 권한이 필요합니다."]); return }
            guard let x = input["x"] as? Double, let y = input["y"] as? Double,
                  x.isFinite, y.isFinite, x >= 0, y >= 0,
                  x < Double(CGDisplayPixelsWide(CGMainDisplayID())), y < Double(CGDisplayPixelsHigh(CGMainDisplayID())) else {
                sendMacScreenResult(id: id, result: ["error": "화면 범위 안의 x/y 좌표를 지정해 주세요."]); return
            }
            let bounds = CGDisplayBounds(CGMainDisplayID())
            let point = CGPoint(x: bounds.minX + x * bounds.width / Double(CGDisplayPixelsWide(CGMainDisplayID())),
                                y: bounds.minY + y * bounds.height / Double(CGDisplayPixelsHigh(CGMainDisplayID())))
            let button: CGMouseButton = input["button"] as? String == "right" ? .right : .left
            let downType: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
            let upType: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
            guard let down = CGEvent(mouseEventSource: nil, mouseType: downType, mouseCursorPosition: point, mouseButton: button),
                  let up = CGEvent(mouseEventSource: nil, mouseType: upType, mouseCursorPosition: point, mouseButton: button) else {
                sendMacScreenResult(id: id, result: ["error": "마우스 이벤트를 만들지 못했습니다."]); return
            }
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
            sendMacScreenResult(id: id, result: ["ok": true, "text": "화면을 클릭했습니다."])
        case "type":
            guard AXIsProcessTrusted() else { sendMacScreenResult(id: id, result: ["error": "키보드 제어를 위해 macOS 손쉬운 사용 권한이 필요합니다."]); return }
            guard let text = input["text"] as? String, !text.isEmpty, text.utf16.count <= 4000 else {
                sendMacScreenResult(id: id, result: ["error": "입력할 문자는 1~4,000자로 제한됩니다."]); return
            }
            let units = Array(text.utf16)
            for start in stride(from: 0, to: units.count, by: 20) {
                let chunk = Array(units[start..<min(start + 20, units.count)])
                for isDown in [true, false] {
                    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: isDown) else { continue }
                    chunk.withUnsafeBufferPointer { buffer in
                        if let baseAddress = buffer.baseAddress {
                            event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: baseAddress)
                        }
                    }
                    event.post(tap: .cghidEventTap)
                }
            }
            sendMacScreenResult(id: id, result: ["ok": true, "text": "문자를 입력했습니다."])
        case "key":
            guard AXIsProcessTrusted() else { sendMacScreenResult(id: id, result: ["error": "키보드 제어를 위해 macOS 손쉬운 사용 권한이 필요합니다."]); return }
            let keyCodes: [String: CGKeyCode] = ["enter": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53,
                "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119,
                "pageup": 116, "pagedown": 121]
            guard let key = input["key"] as? String, let code = keyCodes[key.lowercased()] else {
                sendMacScreenResult(id: id, result: ["error": "허용된 키 이름을 지정해 주세요 (enter/tab/space/backspace/escape/arrows/home/end/pageup/pagedown)."]); return
            }
            let modifiers = input["modifiers"] as? [String] ?? []
            guard modifiers.count <= 3, modifiers.allSatisfy({ ["command", "control", "option", "shift"].contains($0) }) else {
                sendMacScreenResult(id: id, result: ["error": "지원하는 modifier는 command/control/option/shift입니다."]); return
            }
            var flags: CGEventFlags = []
            for modifier in modifiers {
                switch modifier { case "command": flags.insert(.maskCommand); case "control": flags.insert(.maskControl); case "option": flags.insert(.maskAlternate); case "shift": flags.insert(.maskShift); default: break }
            }
            for isDown in [true, false] {
                guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: isDown) else { continue }
                event.flags = flags; event.post(tap: .cghidEventTap)
            }
            sendMacScreenResult(id: id, result: ["ok": true, "text": "키 입력을 보냈습니다."])
        case "scroll":
            guard AXIsProcessTrusted() else { sendMacScreenResult(id: id, result: ["error": "스크롤 제어를 위해 macOS 손쉬운 사용 권한이 필요합니다."]); return }
            let vertical = input["vertical"] as? Int ?? 0
            let horizontal = input["horizontal"] as? Int ?? 0
            guard abs(vertical) <= 10, abs(horizontal) <= 10, vertical != 0 || horizontal != 0,
                  let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
                                      wheel1: Int32(vertical), wheel2: Int32(horizontal), wheel3: 0) else {
                sendMacScreenResult(id: id, result: ["error": "세로/가로 스크롤은 각각 -10~10 범위에서 지정해 주세요."]); return
            }
            event.post(tap: .cghidEventTap)
            sendMacScreenResult(id: id, result: ["ok": true, "text": "화면을 스크롤했습니다."])
        default: sendMacScreenResult(id: id, result: ["error": "지원하지 않는 Mac 화면 작업입니다."])
        }
    }

    private func macScreenPermissionStatus(accessibility: Bool) -> [String: Any] {
        ["screenRecording": CGPreflightScreenCaptureAccess(), "accessibility": accessibility,
         "width": CGDisplayPixelsWide(CGMainDisplayID()), "height": CGDisplayPixelsHigh(CGMainDisplayID())]
    }

    private func sendMacScreenResult(id: String, result: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: [id, result]),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async {
            self.webView.evaluateJavaScript("window.onlyChatMacScreenCommandComplete && window.onlyChatMacScreenCommandComplete(\(json)[0], \(json)[1])")
        }
    }

    private func ensureBrowserWebView() -> NSHostingView<AnyView> {
        if let browserWebView { return browserWebView }
        let browser = BrowserView(
            embedded: true,
            authorizeNavigation: { [weak self] url, completion in
                guard let self else { completion(.unavailable); return }
                self.authorizeBrowserNavigation(url, completion: completion)
            },
            onWebView: { model, view in ThreeFEmbeddedBrowserSession.shared.attach(model: model, webView: view) },
            onBlockedNavigation: { [weak self] url in self?.showBrowserNotice("Focus Fence에서 탐색을 차단했습니다.", url: url) }
        ).environmentObject(ThreeFURLRouter.shared)
        let hostingView = NSHostingView(rootView: AnyView(browser))
        hostingView.autoresizingMask = [.width, .height]
        hostingView.isHidden = true
        webView.addSubview(hostingView)
        browserWebView = hostingView
        return hostingView
    }

    private func sendBrowserResult(action: String, text: String, error: String = "") {
        let payload: [String: Any] = ["action": action, "text": text, "error": error]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { self.webView.evaluateJavaScript("window.onlyChatBrowserResult && window.onlyChatBrowserResult(\(json))") }
    }

    private static func validBrowserURL(_ value: String) -> URL? {
        guard let parts = URLComponents(string: value),
              let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
              parts.host != nil, parts.user == nil, parts.password == nil else { return nil }
        return parts.url
    }

    private func authorizeBrowserNavigation(
        _ url: URL,
        completion: @escaping (BrowserNavigationAuthorizationDecision) -> Void
    ) {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/browser/authorize")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["url": url.absoluteString])
        URLSession.shared.dataTask(with: request) { data, response, _ in
            let payload = (try? JSONSerialization.jsonObject(with: data ?? Data())) as? [String: Any]
            let statusCode = (response as? HTTPURLResponse)?.statusCode
            let decision: BrowserNavigationAuthorizationDecision
            if statusCode == 200, payload?["allowed"] as? Bool == true {
                decision = .allowed
            } else if statusCode == 403, payload?["reason"] as? String == "blocked" {
                decision = .blocked
            } else if statusCode == 403, payload?["reason"] as? String == "youtube_quota_blocked" {
                decision = .youtubeBlocked
            } else {
                decision = .unavailable
            }
            DispatchQueue.main.async {
                if !decision.isAllowed { self.showBrowserNotice("Focus Fence 정책에서 허용하지 않았거나 정책 서비스에 연결할 수 없습니다.", url: url) }
                completion(decision)
            }
        }.resume()
    }

    private func showBrowserNotice(_ message: String, url: URL) {
        sendBrowserResult(action: "navigation", text: url.absoluteString, error: message)
    }

    private func startSpeech(generation: UInt64) {
        guard speechStartRequested, speechStartGeneration == generation else { return }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "ko-KR")), recognizer.isAvailable else {
            speechError("한국어 음성 인식 서비스를 사용할 수 없습니다.", generation: generation)
            return
        }
        guard recognizer.supportsOnDeviceRecognition else {
            speechError("이 Mac의 한국어 음성 인식은 기기 내 처리를 지원하지 않아 시작하지 않았습니다.", generation: generation)
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.requiresOnDeviceRecognition = true
        speechRequest = request
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        if #available(macOS 27.0, *) {
            do {
                try input.installAudioTap(onBus: 0, bufferSize: 1024, format: format) { [weak request] buffer, _ in
                    request?.append(AVAudioPCMBuffer(copying: buffer))
                }
            } catch { speechError("마이크 입력을 연결하지 못했습니다.", generation: generation); return }
        } else {
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak request] buffer, _ in request?.append(buffer) }
        }
        speechTapInstalled = true
        audioEngine.prepare()
        do { try audioEngine.start() } catch { speechError("마이크를 시작하지 못했습니다.", generation: generation); return }
        webView.evaluateJavaScript("window.onlyChatSpeechState(true)")
        speechTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            DispatchQueue.main.async {
                guard self.speechStartRequested, self.speechStartGeneration == generation else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    let encoded = (try? JSONSerialization.data(withJSONObject: [text]))
                        .flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
                    self.webView.evaluateJavaScript("window.onlyChatSpeechResult(\(encoded.dropFirst().dropLast()))")
                }
                if error != nil || result?.isFinal == true { self.stopSpeech(generation: generation) }
            }
        }
    }

    private func stopSpeech(generation: UInt64? = nil) {
        if let generation, generation != speechStartGeneration { return }
        speechStartRequested = false
        speechStartGeneration &+= 1
        if audioEngine.isRunning { audioEngine.stop() }
        if speechTapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            speechTapInstalled = false
        }
        speechRequest?.endAudio()
        speechTask?.cancel()
        speechRequest = nil
        speechTask = nil
        DispatchQueue.main.async { self.webView?.evaluateJavaScript("window.onlyChatSpeechState(false)") }
    }

    private func speechError(_ message: String, generation: UInt64) {
        guard speechStartRequested, speechStartGeneration == generation else { return }
        stopSpeech(generation: generation)
        let data = (try? JSONSerialization.data(withJSONObject: [message])) ?? Data("[\"음성 인식 오류\"]".utf8)
        let encoded = String(data: data, encoding: .utf8) ?? "[\"음성 인식 오류\"]"
        DispatchQueue.main.async { self.webView?.evaluateJavaScript("window.onlyChatSpeechError(\(encoded.dropFirst().dropLast()))") }
    }

    private func projectRoot() -> URL? {
        guard
            let path = Bundle.main.path(forResource: "project-root", ofType: "txt"),
            let root = try? String(contentsOfFile: path, encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines),
            FileManager.default.fileExists(atPath: URL(fileURLWithPath: root).appendingPathComponent("src/ui/desktop/server.js").path)
        else { return nil }
        return URL(fileURLWithPath: root, isDirectory: true)
    }

    private func startServer() {
        guard let root = projectRoot() else {
            showError("Only Chat 원본 폴더를 찾지 못했습니다. 앱을 다시 빌드해 주세요.")
            return
        }
        let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
            .first(where: FileManager.default.isExecutableFile(atPath:))
        guard let node else {
            showError("Node.js를 찾지 못했습니다. 이 Mac에 Node.js를 설치한 뒤 다시 실행해 주세요.")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.currentDirectoryURL = root
        process.arguments = [
            "-e",
            "const path=require('node:path');const {DesktopServer}=require('./src/ui/desktop/server.js');const options={port:Number(process.env.PORT)||8899};if(process.env.ONLY_CHAT_ISOLATED==='1')options.isolated=true;if(process.env.ONLY_CHAT_DATA_DIR){options.dataDir=process.env.ONLY_CHAT_DATA_DIR;options.workspaceDir=path.join(options.dataDir,'workspace');}const server=new DesktopServer(options);process.on('SIGTERM',()=>server.stop());server.start().then(({url})=>console.log('Only Chat ready: '+url)).catch(error=>{console.error(error);server.stop();process.exitCode=1;});"
        ]
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        environment["PORT"] = String(port)
        if let resources = Bundle.main.resourceURL {
            environment["ONLY_CHAT_KEYCHAIN_HELPER"] = resources.appendingPathComponent("OnlyChatCredentialBridge").path
        }
        let isolatedPreview = Bundle.main.object(forInfoDictionaryKey: "OnlyChatIsolatedPreview") as? Bool == true
        environment["ONLY_CHAT_NATIVE_MAC_SCREEN_CONTROL"] = isolatedPreview ? "0" : "1"
        if isolatedPreview {
            environment["ONLY_CHAT_ISOLATED"] = "1"
            environment["TMPDIR"] = "/tmp"
            if let profile = Bundle.main.object(forInfoDictionaryKey: "OnlyChatPreviewDataDirectory") as? String, !profile.isEmpty {
                environment["ONLY_CHAT_DATA_DIR"] = profile
            }
        }
        process.environment = environment
        if let logPath = Bundle.main.object(forInfoDictionaryKey: "OnlyChatDiagnosticLogPath") as? String,
           !logPath.isEmpty {
            if !FileManager.default.fileExists(atPath: logPath) {
                FileManager.default.createFile(atPath: logPath, contents: nil)
            }
            serverDiagnosticsHandle = try? FileHandle(forWritingTo: URL(fileURLWithPath: logPath))
        }
        process.standardOutput = serverDiagnosticsHandle ?? FileHandle.nullDevice
        process.standardError = serverDiagnosticsHandle ?? FileHandle.nullDevice
        process.terminationHandler = { [weak self] child in
            DispatchQueue.main.async {
                guard child.terminationStatus != 0, self?.window.isVisible == true else { return }
                self?.showError("Only Chat 서버가 시작되지 않았습니다. 포트 \(self?.port ?? 8899)를 확인해 주세요.")
            }
        }

        do {
            try process.run()
            serverProcess = process
            waitForServer(attempt: 0)
        } catch {
            showError("Only Chat 서버를 시작하지 못했습니다: \(error.localizedDescription)")
        }
    }

    private func waitForServer(attempt: Int) {
        guard attempt < 60, serverProcess?.isRunning == true else {
            if attempt >= 60 {
                showError("Only Chat 서버 응답을 기다리다 시간 초과됐습니다.")
            }
            return
        }
        let url = URL(string: "http://127.0.0.1:\(port)/")!
        URLSession.shared.dataTask(with: url) { [weak self] _, response, _ in
            DispatchQueue.main.async {
                guard let self, self.serverProcess?.isRunning == true else { return }
                if (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.webView.load(URLRequest(url: url))
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                        self.waitForServer(attempt: attempt + 1)
                    }
                }
            }
        }.resume()
    }

    private func isLocalAppURL(_ url: URL) -> Bool {
        url.scheme == "http" && url.host == "127.0.0.1" && url.port == port
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("document.querySelector('.mac-titlebar .traffic-lights')?.remove()")
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if isLocalAppURL(url) {
            decisionHandler(.allow)
        } else if ["https", "http"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else {
            decisionHandler(.cancel)
        }
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        guard frame.isMainFrame, frame.request.url.map(isLocalAppURL) == true, let window else {
            completionHandler(nil)
            return
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.resolvesAliases = true
        panel.prompt = "선택"
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        guard frame.isMainFrame, frame.request.url.map(isLocalAppURL) == true, let window else {
            completionHandler()
            return
        }
        let alert = NSAlert()
        alert.messageText = "Only Chat"
        alert.informativeText = message
        alert.alertStyle = .informational
        alert.addButton(withTitle: "확인")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptConfirmPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (Bool) -> Void
    ) {
        guard frame.isMainFrame, frame.request.url.map(isLocalAppURL) == true, let window else {
            completionHandler(false)
            return
        }
        let alert = NSAlert()
        alert.messageText = "Only Chat"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "취소")
        alert.addButton(withTitle: "확인")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertSecondButtonReturn)
        }
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptTextInputPanelWithPrompt prompt: String,
        defaultText: String?,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping (String?) -> Void
    ) {
        guard frame.isMainFrame, frame.request.url.map(isLocalAppURL) == true, let window else {
            completionHandler(nil)
            return
        }
        let alert = NSAlert()
        alert.messageText = "Only Chat"
        alert.informativeText = prompt
        alert.alertStyle = .informational
        let input = NSTextField(string: defaultText ?? "")
        input.frame = NSRect(x: 0, y: 0, width: 300, height: 24)
        input.setAccessibilityLabel("입력")
        alert.accessoryView = input
        alert.addButton(withTitle: "확인")
        alert.addButton(withTitle: "취소")
        alert.window.initialFirstResponder = input
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn ? input.stringValue : nil)
        }
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, ["https", "http"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Only Chat"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "확인")
        alert.beginSheetModal(for: window)
    }
}
