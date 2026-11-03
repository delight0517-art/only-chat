# Only Chat — 연결되는 작업실

Created 2026-11-03 · Source: canonical `my-codex` checkout, existing `main`.

## Product idea

대화 하나에서, 앱들이 함께 진화합니다.

Only Chat connects a goal to scoped work, an identifiable source, an owner, a next action and review evidence. The interface makes those connections visible alongside conversation. “신체 개조” means independently replaceable features with controlled integration; the UI must not imply that merely displaying modules prevents conflicts or commits code.

## Visual language shared by the app family

- Paper and ink: warm ivory backgrounds, deep green text, restrained copper actions, teal connections. Dark mode keeps the same hierarchy. The existing optional fantasy theme retains its own palette.
- Signature: interlocking O/C forms, one continuous process. Use the same mark in the workspace and entry screen; the conversation bubble alone does not express the product.
- Layout: navigation on the left, the goal/conversation in the center, a collapsible work map beside it. Narrow layouts stack the map below conversation, preserving reading and focus order. The input always remains reachable.
- Information: goal → app/feature work → review and integration. Give tasks names, source roots, owners, next actions, blockers and evidence. Do not show invented apps, fake percentages, synthetic green checks or unsupported “all clean” badges.
- Motion: a single short entrance, deliberate hover and disclosure responses. Animate opacity and transforms; respect reduced motion and keep persistent status static. No looping decorative animation, extra motion library or external fonts.
- Interaction: native buttons/details, visible keyboard focus, text status alongside color, Escape from the map returns focus to its toggle. Suggested prompts fill the composer and never send automatically.

The shared style tokens and first implementation live in `src/ui/desktop/app.css` under “Connected workspace”. Reuse the naming and behavior when adapting another app to its existing native/web theme layer; do not copy the entire Only Chat shell into every product.

## Implemented information contracts

| Surface | Source | Meaning / limit |
| --- | --- | --- |
| Work map | `GET /api/task-registry/tasks?limit=200` | Most recent registered records, not a complete machine-wide app inventory. Up to eight matching tasks displayed, attention first. |
| Owner / progress | Record status + owner + lease expiry | Missing/expired owner lease is “담당 확인 필요”; a checkpoint is not a live process probe. |
| Completion | Checkpoint evidence references | “완료 기록” describes a saved status, not independently verified installation or runtime. Missing evidence needs attention. |
| Source state | `GET /api/ownership` | Current selected workspace; read the actual top-level `uncommitted` list. Missing lists remain unknown. |
| Replaceable features | `GET /api/morph/status` | Registered hub slots and their reported versions, not cross-app loaded-revision proof. |

Reads occur on entry, explicit refresh and return focus while the map is open and not being used. There is no new polling job. Snapshot reads have a six-second timeout. Failed reads show unknown values rather than zeroes or a clean state. Task data is inserted with text nodes; evidence paths are plain text, never trusted HTML.

Opening the map performs no claim, enqueue, commit, source mutation or cross-chat message. Safe existing renderer reload boundaries remain in effect. Server/core/native changes retain their separate restart/build requirements.

## Family rollout / remaining work

- [ ] Adapt this visual grammar to the other apps as each canonical app receives its next authorized feature slice. Preserve each product's recognizable identity and native conventions.
- [ ] Add producer/consumer relation edges once a real cross-app dependency contract exposes them; the current illustrated branching/return path is a concept diagram, not live dependency data.
- [ ] Verify the real multi-chat registry update journey separately from fixture-based UI validation. Keep source, local UI, native installation and Windows receiver evidence distinct.
- [ ] Validate native installed wrapper / Dock identity with this design when installation is requested. This renderer change does not rebuild the app icon.

User authorization: refine Only Chat design, UI and animation so connected app work and modular evolution are visible, and establish a coherent design concept for the app family.

## Validation receipt — 2026-11-03

- JavaScript syntax and `git diff --check` passed.
- Ten focused test files passed (18 checks): workbench and ownership presentation, chat/static delivery, session sidebar and workspace status, session/dictation preservation, queue preparation safeguards and metamorphic hub behavior. No real provider request was sent.
- Actual Aside UI at `localhost:18991` used current canonical HTML/CSS/JS and an isolated DesktopServer. Only the registry response was replaced by clearly labelled example records. Expanded task details, owner/source/next-step text, completion filter, unavailable response with unknown counters, source-settings navigation, module-hub opening and draft preservation across map refresh were observed.
- The initial module shortcut failed because the old toggle used a nonexistent DOM ID; wiring now targets `railGridBtn`, and visible drawer opening was confirmed after reload.
- [Saved preview](onlychat-design-preview.png) is an unedited screenshot of example data, not live app execution evidence. Sidebar was collapsed to exclude unrelated queue content.
- The one task-created Aside tab was closed; both temporary preview profiles were removed and the test server exited. No native app build, install or Windows action was performed. The current light-mode desktop layout was visually checked; dark mode, reduced motion and narrow layout are implemented but were not visually checked.
