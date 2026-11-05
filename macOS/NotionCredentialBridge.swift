import Foundation
import Security
import Darwin

private struct Request: Decodable {
    let action: String
    let value: String?
}

private func respond(_ value: [String: Any]) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: value),
       let line = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
    exit(0)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let request = try? JSONDecoder().decode(Request.self, from: input) else {
    respond(["ok": false, "error": "잘못된 자격증명 브리지 요청입니다."])
}

var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "com.rogan.onlychat.notion",
    kSecAttrAccount as String: "hosted-mcp-oauth"
]

#if ONLY_CHAT_KEYCHAIN_TESTING
var testKeychain: SecKeychain?
if let path = ProcessInfo.processInfo.environment["ONLY_CHAT_TEST_KEYCHAIN_PATH"] {
    guard SecKeychainOpen((path as NSString).fileSystemRepresentation, &testKeychain) == errSecSuccess,
          let testKeychain else {
        respond(["ok": false, "error": "임시 테스트 키체인을 열지 못했습니다."])
    }
    query[kSecMatchSearchList as String] = [testKeychain]
}
#endif

switch request.action {
case "get":
    var attributes = query
    attributes[kSecReturnData as String] = true
    attributes[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(attributes as CFDictionary, &result)
    if status == errSecItemNotFound { respond(["ok": true, "value": NSNull()]) }
    guard status == errSecSuccess, let data = result as? Data,
          let value = String(data: data, encoding: .utf8) else {
        respond(["ok": false, "error": "macOS 키체인에서 Notion 연결 정보를 읽지 못했습니다."])
    }
    respond(["ok": true, "value": value])
case "set":
    guard let value = request.value, value.utf8.count <= 65_536 else {
        respond(["ok": false, "error": "저장할 Notion 연결 정보가 없거나 너무 큽니다."])
    }
    let data = Data(value.utf8)
    let updateStatus = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if updateStatus == errSecItemNotFound {
        var item = query
        #if ONLY_CHAT_KEYCHAIN_TESTING
        if let testKeychain {
            item.removeValue(forKey: kSecMatchSearchList as String)
            item[kSecUseKeychain as String] = testKeychain
        }
        #endif
        item[kSecValueData as String] = data
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else { respond(["ok": false, "error": "macOS 키체인에 Notion 연결 정보를 저장하지 못했습니다."]) }
    } else if updateStatus != errSecSuccess {
        respond(["ok": false, "error": "macOS 키체인에 Notion 연결 정보를 저장하지 못했습니다."])
    }
    var verificationQuery = query
    verificationQuery[kSecReturnData as String] = true
    verificationQuery[kSecMatchLimit as String] = kSecMatchLimitOne
    var verificationResult: CFTypeRef?
    let verificationStatus = SecItemCopyMatching(verificationQuery as CFDictionary, &verificationResult)
    guard verificationStatus == errSecSuccess,
          let savedData = verificationResult as? Data,
          savedData == data else {
        respond(["ok": false, "error": "저장된 Notion 연결 정보를 다시 읽어 확인하지 못했습니다."])
    }
    respond(["ok": true, "verified": true])
case "delete":
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        respond(["ok": false, "error": "macOS 키체인에서 Notion 연결 정보를 삭제하지 못했습니다."])
    }
    respond(["ok": true])
default:
    respond(["ok": false, "error": "지원하지 않는 자격증명 브리지 작업입니다."])
}
