import AppKit
import ApplicationServices
import Foundation

// Owned opt-in stream. It never reads AXValue, clipboard, titles, or printable
// input text. Selection mode reads AXSelectedText only after a user input event.
let mode = CommandLine.arguments.dropFirst().first ?? ""
let ownerPid = getppid()
func emit(_ value: [String: Any]) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: value), bytes.count <= 280000 else { return }
    FileHandle.standardOutput.write(bytes); FileHandle.standardOutput.write(Data([10]))
}
func attr(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success ? value : nil
}
func axValue(_ raw: CFTypeRef?, _ type: AXValueType) -> AXValue? {
    guard let raw = raw, CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    let value = unsafeBitCast(raw, to: AXValue.self)
    return AXValueGetType(value) == type ? value : nil
}
func bounds(_ element: AXUIElement) -> [String: Double]? {
    var p = CGPoint.zero, s = CGSize.zero
    guard let pos = axValue(attr(element, kAXPositionAttribute), .cgPoint), let size = axValue(attr(element, kAXSizeAttribute), .cgSize),
          AXValueGetValue(pos, .cgPoint, &p), AXValueGetValue(size, .cgSize, &s), p.x.isFinite, p.y.isFinite, s.width > 0, s.height > 0 else { return nil }
    return ["x": p.x, "y": p.y, "width": s.width, "height": s.height]
}
func focused(_ application: NSRunningApplication) -> AXUIElement? {
    let app = AXUIElementCreateApplication(application.processIdentifier); AXUIElementSetMessagingTimeout(app, 0.25)
    guard let raw = attr(app, kAXFocusedUIElementAttribute), CFGetTypeID(raw) == AXUIElementGetTypeID() else { return nil }
    let element = unsafeBitCast(raw, to: AXUIElement.self); AXUIElementSetMessagingTimeout(element, 0.25); return element
}
func protected(_ element: AXUIElement) -> Bool {
    let role = attr(element, kAXRoleAttribute) as? String ?? "", subrole = attr(element, kAXSubroleAttribute) as? String ?? ""
    // Opaque/editable controls are skipped for recording, including password and
    // payment fields that native apps cannot classify consistently.
    return role == "AXSecureTextField" || subrole == "AXSecureTextField" || attr(element, "AXProtectedContent") as? Bool == true
}
func appInfo(_ app: NSRunningApplication) -> [String: Any]? {
    guard let bundle = app.bundleIdentifier, let name = app.localizedName, bundle.count <= 255 else { return nil }
    return ["bundleId": bundle, "appName": String(name.prefix(300)), "pid": Int(app.processIdentifier)]
}
func frontmost() -> [String: Any]? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }; return appInfo(app)
}
if mode == "--apps" {
    emit(["apps": NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }.compactMap(appInfo)]); exit(0)
}
if mode == "--frontmost" { emit(frontmost() ?? [:]); exit(0) }
if mode == "--status" { emit(["accessibility": AXIsProcessTrusted(), "inputMonitoring": CGPreflightListenEventAccess(), "screen": CGPreflightScreenCaptureAccess()]); exit(0) }
guard mode == "--selection-watch" || mode == "--record" else { exit(2) }
let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 65536, let request = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any], let excluded = request["excludedApps"] as? [String], excluded.count <= 128 else { exit(2) }
let targetBundle = request["bundleId"] as? String ?? ""
guard AXIsProcessTrusted() else { emit(["type":"error", "code":"accessibility_denied"]); exit(0) }
if mode == "--record" && (!CGPreflightListenEventAccess() || !CGPreflightScreenCaptureAccess() || targetBundle.isEmpty) { emit(["type":"error", "code":"recording_permissions_required"]); exit(0) }
let monitorApplication = NSApplication.shared
monitorApplication.setActivationPolicy(.prohibited)
var lastSelection = "", selectionWork: DispatchWorkItem?, lastScroll = Date.distantPast
func selection() {
    guard let application = NSWorkspace.shared.frontmostApplication, let info = appInfo(application), let bundle = info["bundleId"] as? String,
          !excluded.contains(bundle), let element = focused(application), !protected(element),
          let text = attr(element, kAXSelectedTextAttribute) as? String, text.lengthOfBytes(using: .utf8) <= 131072,
          !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { lastSelection = ""; emit(["type":"clear"]); return }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == application.processIdentifier else { return }
    // Held only in the helper's memory, never persisted or logged.
    let identity = String(application.processIdentifier) + ":" + text
    guard identity != lastSelection else { return }; lastSelection = identity
    var value: [String:Any] = ["type":"selection", "text":text, "source":info]
    if let b = bounds(element) {
        value["bounds"] = b
        // Keyboard and AX-targeted input need not move the physical pointer.
        // Anchor to the selected range when available, otherwise the control.
        var anchor = CGPoint(x:b["x"]!,y:b["y"]!+b["height"]!)
        if let range = attr(element,kAXSelectedTextRangeAttribute) {
            var raw: CFTypeRef?
            if AXUIElementCopyParameterizedAttributeValue(element,kAXBoundsForRangeParameterizedAttribute as CFString,range,&raw) == .success,
               let value = axValue(raw,.cgRect) {
                var rect = CGRect.zero
                if AXValueGetValue(value,.cgRect,&rect), rect.width.isFinite, rect.height.isFinite {
                    anchor = CGPoint(x:rect.minX,y:rect.maxY)
                }
            }
        }
        value["point"] = ["x":anchor.x,"y":anchor.y]
    } else {
        let p = CGEvent(source:nil)?.location ?? .zero; value["point"] = ["x":p.x,"y":p.y]
    }
    emit(value)
}
let navigation: [UInt16:String] = [48:"Tab",36:"Enter",53:"Escape",123:"ArrowLeft",124:"ArrowRight",125:"ArrowDown",126:"ArrowUp",115:"Home",119:"End",116:"PageUp",121:"PageDown",51:"Backspace",117:"Delete",122:"F1",120:"F2",99:"F3",118:"F4",96:"F5",97:"F6",98:"F7",100:"F8",101:"F9",109:"F10",103:"F11",111:"F12"]
func record(_ event: NSEvent) {
    guard let app = NSWorkspace.shared.frontmostApplication, app.bundleIdentifier == targetBundle, !excluded.contains(targetBundle), let info = appInfo(app), let focus = focused(app), !protected(focus) else { return }
    let point = event.cgEvent?.location ?? CGEvent(source:nil)?.location ?? .zero
    var action: [String:Any] = [:]
    switch event.type {
    case .leftMouseUp, .rightMouseUp, .otherMouseUp: action["kind"] = "click"
    case .scrollWheel:
        guard Date().timeIntervalSince(lastScroll) >= 0.15 else { return }; lastScroll = Date()
        action = ["kind":"scroll", "deltaX":event.scrollingDeltaX,"deltaY":event.scrollingDeltaY]
    case .keyDown:
        let flags = event.modifierFlags
        // Never request characters/charactersIgnoringModifiers: keycodes alone
        // provide navigation keys; printable keystrokes are intentionally omitted.
        guard let key = navigation[event.keyCode] else { return }
        let role = attr(focus, kAXRoleAttribute) as? String ?? ""
        guard !["AXTextField","AXTextArea","AXComboBox"].contains(role) else { return }
        action = ["kind":"key","key":key,"ctrlKey":flags.contains(.control),"metaKey":flags.contains(.command),"altKey":flags.contains(.option),"shiftKey":flags.contains(.shift)]
    default: return
    }
    var target = focus
    if action["kind"] as? String == "click" {
        let system = AXUIElementCreateSystemWide(); var found: AXUIElement?
        if AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &found) == .success, let found = found { target = found }
    }
    var targetPid: pid_t = 0
    guard AXUIElementGetPid(target, &targetPid) == .success, targetPid == app.processIdentifier, !protected(target) else { return }
    // The owning app and window are fixed to the selected bundle, excluding
    // floating/system overlays and offscreen windows. No window titles retained.
    guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly,.excludeDesktopElements], kCGNullWindowID) as? [[String:Any]],
          let window = windows.first(where: { ($0[kCGWindowOwnerPID as String] as? Int) == Int(app.processIdentifier) && ($0[kCGWindowLayer as String] as? Int) == 0 && ($0[kCGWindowBounds as String] as? [String:Any]) != nil }),
          let rawBounds = window[kCGWindowBounds as String] as? [String:Any], let rect = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
          let windowId = window[kCGWindowNumber as String] as? Int, rect.width > 0, rect.height > 0 else { return }
    var b: [String:Double] = ["x":rect.minX,"y":rect.minY,"width":rect.width,"height":rect.height]
    // Global Quartz positions share the same multi-display coordinate space.
    let mainHeight = NSScreen.screens.first?.frame.height ?? 0
    let nsPoint = NSPoint(x:rect.midX,y:mainHeight-rect.midY)
    let scale = NSScreen.screens.first(where: {$0.frame.contains(nsPoint)})?.backingScaleFactor ?? 1
    b["scale"] = scale
    action["x"] = (point.x - rect.minX) * scale; action["y"] = (point.y - rect.minY) * scale
    if let box = bounds(target) { action["box"] = ["x":(box["x"]! - rect.minX)*scale,"y":(box["y"]! - rect.minY)*scale,"width":box["width"]!*scale,"height":box["height"]!*scale] }
    action["type"] = "action"; action["source"] = info; action["windowId"] = windowId; action["windowBounds"] = b
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { return }; emit(action)
}
// A listen-only annotated-session event tap observes metadata without suppressing or
// changing input. The session tap and NSEvent global monitors did not receive the native
// QA host; the tap's enabled state is checked, and interruption stops the stream.
let types: [CGEventType] = mode == "--selection-watch" ? [.leftMouseUp,.keyUp] : [.leftMouseUp,.rightMouseUp,.otherMouseUp,.keyDown,.scrollWheel]
let eventMask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
final class EventSink {
    let handler: (CGEventType,CGEvent) -> Void
    init(_ handler: @escaping (CGEventType,CGEvent) -> Void) { self.handler = handler }
}
let sink = EventSink { type, event in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        emit(["type":"error","code":"monitor_interrupted"]); exit(0)
    }
    if let nativeEvent = NSEvent(cgEvent:event) {
        if mode == "--record" { DispatchQueue.main.async { record(nativeEvent) } }
        else if type == .leftMouseUp || type == .keyUp {
            // AXSelectedText is the sole text source. Keyboard metadata does not
            // expose characters. A key-up can select text via Command+A as well
            // as Shift navigation; empty selections only clear the preview.
            selectionWork?.cancel(); let work = DispatchWorkItem { selection() }; selectionWork = work
            DispatchQueue.main.asyncAfter(deadline:.now()+0.16,execute:work)
        }
    }
}
let sinkPointer = Unmanaged.passUnretained(sink).toOpaque()
guard let monitor = CGEvent.tapCreate(tap:.cgAnnotatedSessionEventTap, place:.tailAppendEventTap, options:.listenOnly, eventsOfInterest:eventMask, callback:{ _,type,event,context in
          if let context = context { Unmanaged<EventSink>.fromOpaque(context).takeUnretainedValue().handler(type,event) }
          return Unmanaged.passUnretained(event)
      }, userInfo:sinkPointer),
      let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault,monitor,0) else {
    emit(["type":"error","code":"monitor_unavailable"]); exit(0)
}
CFRunLoopAddSource(CFRunLoopGetMain(),source,.commonModes)
CGEvent.tapEnable(tap:monitor,enable:true)
let timer = Timer.scheduledTimer(withTimeInterval:1,repeats:true) { _ in
    if getppid() != ownerPid { CFMachPortInvalidate(monitor); exit(0) }
    if !AXIsProcessTrusted() || !CGEvent.tapIsEnabled(tap:monitor) || (mode == "--record" && (!CGPreflightListenEventAccess() || !CGPreflightScreenCaptureAccess())) {
        emit(["type":"error","code":"permission_revoked"]); CFMachPortInvalidate(monitor); exit(0)
    }
}
emit(["type":"ready","mode":mode])
withExtendedLifetime((timer,sink)) { monitorApplication.run() }
