import AppKit
import ApplicationServices
import Foundation

// One explicit read, no observer, polling, synthetic keypress or clipboard use.
// The main application owns the opt-in/policy and shows a preview before use.
func emit(_ object: [String: Any]) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: object) {
        FileHandle.standardOutput.write(data)
    }
    exit(0)
}
if CommandLine.arguments.contains("--status") { emit(["trusted": AXIsProcessTrusted()]) }
guard AXIsProcessTrusted() else { emit(["ok": false, "code": "accessibility_denied"]) }
let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 65536,
      let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any],
      let exclusions = request["excludedApps"] as? [String], exclusions.count <= 128 else {
    emit(["ok": false, "code": "unsupported"])
}
guard let application = NSWorkspace.shared.frontmostApplication,
      let bundle = application.bundleIdentifier,
      let name = application.localizedName else { emit(["ok": false, "code": "unsupported"]) }
guard !exclusions.contains(bundle) else { emit(["ok": false, "code": "excluded"]) }
let appElement = AXUIElementCreateApplication(application.processIdentifier)
AXUIElementSetMessagingTimeout(appElement, 0.4)
func attribute(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, key as CFString, &value) == .success ? value : nil
}
guard let raw = attribute(appElement, kAXFocusedUIElementAttribute),
      CFGetTypeID(raw) == AXUIElementGetTypeID() else { emit(["ok": false, "code": "unsupported"]) }
let focused = unsafeBitCast(raw, to: AXUIElement.self)
AXUIElementSetMessagingTimeout(focused, 0.4)
let role = attribute(focused, kAXRoleAttribute) as? String ?? ""
let subrole = attribute(focused, kAXSubroleAttribute) as? String ?? ""
if role == "AXSecureTextField" || subrole == "AXSecureTextField" ||
   (attribute(focused, "AXProtectedContent") as? Bool == true) {
    emit(["ok": false, "code": "secure"])
}
guard let text = attribute(focused, kAXSelectedTextAttribute) as? String else {
    emit(["ok": false, "code": "unsupported"])
}
guard text.lengthOfBytes(using: .utf8) <= 131072 else { emit(["ok": false, "code": "too_large"]) }
guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { emit(["ok": false, "code": "no_selection"]) }
// Do not associate a selection with a different app after focus changed.
guard NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier else {
    emit(["ok": false, "code": "unsupported"])
}
emit(["ok": true, "text": text, "appName": name, "bundleId": bundle])
