#!/usr/bin/env swift

import ApplicationServices
import Foundation

private let pollInterval: TimeInterval = 0.25
private let maximumDepth = 24
private let maximumElements = 2_000

private func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

guard CommandLine.arguments.count == 3,
      let rawPid = Int32(CommandLine.arguments[2]),
      rawPid > 0 else {
  fail("usage: macos-updater-e2e.swift <install-success|install-failure|restart> <balance-pid>")
}

private let mode = CommandLine.arguments[1]
guard ["install-success", "install-failure", "restart"].contains(mode) else {
  fail("unknown updater E2E mode: \(mode)")
}

guard AXIsProcessTrusted() else {
  fail("macOS Accessibility permission is required for the native updater E2E test")
}

private let app = AXUIElementCreateApplication(pid_t(rawPid))

private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
    return nil
  }
  return value
}

private func stringAttribute(_ element: AXUIElement, _ name: String) -> String {
  (attribute(element, name) as? String) ?? ""
}

private func children(_ element: AXUIElement) -> [AXUIElement] {
  (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

private func firstElement(
  in root: AXUIElement,
  matching predicate: (AXUIElement) -> Bool
) -> AXUIElement? {
  var visited = 0

  func walk(_ element: AXUIElement, depth: Int) -> AXUIElement? {
    guard depth <= maximumDepth, visited < maximumElements else { return nil }
    visited += 1
    if predicate(element) { return element }
    for child in children(element) {
      if let match = walk(child, depth: depth + 1) { return match }
    }
    return nil
  }

  return walk(root, depth: 0)
}

private func firstWindow() -> AXUIElement? {
  if let focused = attribute(app, kAXFocusedWindowAttribute),
     CFGetTypeID(focused) == AXUIElementGetTypeID() {
    return unsafeBitCast(focused, to: AXUIElement.self)
  }
  return (attribute(app, kAXWindowsAttribute) as? [AXUIElement])?.first
}

private func waitForWindow(timeout: TimeInterval) -> AXUIElement {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if let window = firstWindow() { return window }
    Thread.sleep(forTimeInterval: pollInterval)
  }
  fail("Balance updater E2E window did not appear")
}

private func elementHasExactText(_ element: AXUIElement, _ target: String) -> Bool {
  [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute]
    .contains { stringAttribute(element, $0).trimmingCharacters(in: .whitespacesAndNewlines) == target }
}

private func waitForExactText(_ target: String, timeout: TimeInterval) {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if let window = firstWindow(),
       firstElement(in: window, matching: { elementHasExactText($0, target) }) != nil {
      return
    }
    Thread.sleep(forTimeInterval: pollInterval)
  }
  fail("Balance updater E2E text did not appear: \(target)")
}

private func hasExactText(_ target: String) -> Bool {
  guard let window = firstWindow() else { return false }
  return firstElement(in: window, matching: { elementHasExactText($0, target) }) != nil
}

private func waitForButton(_ title: String, timeout: TimeInterval) -> AXUIElement {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if let window = firstWindow(),
       let button = firstElement(in: window, matching: {
         stringAttribute($0, kAXRoleAttribute) == kAXButtonRole &&
           elementHasExactText($0, title)
       }) {
      return button
    }
    Thread.sleep(forTimeInterval: pollInterval)
  }
  fail("Balance updater E2E button did not appear: \(title)")
}

private func pressButton(_ title: String, timeout: TimeInterval) {
  let result = AXUIElementPerformAction(
    waitForButton(title, timeout: timeout),
    kAXPressAction as CFString
  )
  guard result == .success else {
    fail("Balance updater button press failed for \(title): AXError \(result.rawValue)")
  }
}

private func enterDashboardIfNeeded() {
  let deadline = Date().addingTimeInterval(30)
  while Date() < deadline {
    if hasExactText("应用更新") { return }
    if hasExactText("余量初始设置") {
      pressButton("查看演示", timeout: 20)
      waitForExactText("应用更新", timeout: 30)
      return
    }
    Thread.sleep(forTimeInterval: pollInterval)
  }
  fail("Balance updater E2E did not reach onboarding or the update settings view")
}

private func scrollToTop() {
  guard let source = CGEventSource(stateID: .combinedSessionState),
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 126, keyDown: true),
        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 126, keyDown: false) else {
    fail("Balance updater E2E could not create a scroll-to-top keyboard event")
  }
  keyDown.flags = .maskCommand
  keyUp.flags = .maskCommand
  keyDown.post(tap: .cghidEventTap)
  keyUp.post(tap: .cghidEventTap)
  Thread.sleep(forTimeInterval: pollInterval)
}

private func pressUpdate() {
  pressButton("更新", timeout: 20)
}

private func quitThroughApplicationMenu() {
  guard let rawMenuBar = attribute(app, kAXMenuBarAttribute),
        CFGetTypeID(rawMenuBar) == AXUIElementGetTypeID() else {
    fail("Balance updater E2E could not find the application menu bar")
  }
  let menuBar = unsafeBitCast(rawMenuBar, to: AXUIElement.self)
  guard let appMenu = firstElement(in: menuBar, matching: {
    stringAttribute($0, kAXRoleAttribute) == kAXMenuBarItemRole &&
      stringAttribute($0, kAXTitleAttribute) == "Balance"
  }) else {
    fail("Balance updater E2E could not find the Balance application menu")
  }
  guard AXUIElementPerformAction(appMenu, kAXPressAction as CFString) == .success else {
    fail("Balance updater E2E could not open the Balance application menu")
  }

  let deadline = Date().addingTimeInterval(5)
  while Date() < deadline {
    if let quitItem = firstElement(in: menuBar, matching: {
      stringAttribute($0, kAXRoleAttribute) == kAXMenuItemRole &&
        stringAttribute($0, kAXTitleAttribute) == "退出余量"
    }) {
      let result = AXUIElementPerformAction(quitItem, kAXPressAction as CFString)
      guard result == .success else {
        fail("Balance updater E2E could not press 退出余量: AXError \(result.rawValue)")
      }
      return
    }
    Thread.sleep(forTimeInterval: pollInterval)
  }
  fail("Balance updater E2E could not find 退出余量")
}

let frontmostResult = AXUIElementSetAttributeValue(
  app,
  kAXFrontmostAttribute as CFString,
  kCFBooleanTrue
)
guard frontmostResult == .success else {
  fail("Balance updater E2E could not foreground the app: AXError \(frontmostResult.rawValue)")
}

_ = waitForWindow(timeout: 20)
enterDashboardIfNeeded()

switch mode {
case "install-success":
  scrollToTop()
  waitForExactText("应用更新", timeout: 30)
  pressUpdate()
  waitForExactText(
    "更新到 0.3.1 已完成。请从菜单栏选择「退出余量」，再重新打开即可使用最新版本。",
    timeout: 180
  )
case "install-failure":
  scrollToTop()
  waitForExactText("应用更新", timeout: 30)
  pressUpdate()
  waitForExactText("自动更新失败，请检查网络后重试", timeout: 60)
case "restart":
  waitForExactText("应用更新", timeout: 30)
default:
  fail("unreachable updater E2E mode")
}

quitThroughApplicationMenu()
print("native-updater-ui-ok: \(mode)")
