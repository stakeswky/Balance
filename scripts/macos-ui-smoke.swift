#!/usr/bin/env swift

import ApplicationServices
import Foundation

private let pollInterval: TimeInterval = 0.25
private let maximumDepth = 20
private let maximumElements = 1_500

private func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

private let startupErrorMode = CommandLine.arguments.count == 3 &&
  CommandLine.arguments[1] == "--startup-error"
private let pidArgument = startupErrorMode ? CommandLine.arguments[2] :
  (CommandLine.arguments.count == 2 ? CommandLine.arguments[1] : "")

guard (CommandLine.arguments.count == 2 || startupErrorMode),
      let rawPid = Int32(pidArgument),
      rawPid > 0 else {
  fail("usage: macos-ui-smoke.swift [--startup-error] <synq-pid>")
}

guard AXIsProcessTrusted() else {
  fail("macOS Accessibility permission is required for the native Synq UI smoke test")
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
    if let window = firstWindow() {
      return window
    }
    Thread.sleep(forTimeInterval: pollInterval)
  }
  fail("Synq native window did not appear")
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

private func elementHasExactText(_ element: AXUIElement, _ target: String) -> Bool {
  [kAXTitleAttribute, kAXValueAttribute, kAXDescriptionAttribute]
    .contains { stringAttribute(element, $0).trimmingCharacters(in: .whitespacesAndNewlines) == target }
}

private func hasExactText(_ target: String) -> Bool {
  guard let window = firstWindow() else { return false }
  return firstElement(in: window) { elementHasExactText($0, target) } != nil
}

private func waitForExactText(_ target: String, timeout: TimeInterval) {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if hasExactText(target) { return }
    Thread.sleep(forTimeInterval: pollInterval)
  }
  fail("Synq native UI text did not appear: \(target)")
}

private func button(named target: String) -> AXUIElement? {
  guard let window = firstWindow() else { return nil }
  return firstElement(in: window) {
    stringAttribute($0, kAXRoleAttribute) == kAXButtonRole &&
      stringAttribute($0, kAXTitleAttribute) == target
  }
}

private enum InitialAppState {
  case onboarding
  case dashboard
}

private func initialAppState() -> InitialAppState? {
  guard let window = firstWindow() else { return nil }
  var visited = 0

  func walk(_ element: AXUIElement, depth: Int) -> InitialAppState? {
    guard depth <= maximumDepth, visited < maximumElements else { return nil }
    visited += 1
    if elementHasExactText(element, "Synq 初始设置") { return .onboarding }
    if stringAttribute(element, kAXRoleAttribute) == kAXButtonRole &&
       stringAttribute(element, kAXTitleAttribute) == "设置" {
      return .dashboard
    }
    for child in children(element) {
      if let state = walk(child, depth: depth + 1) { return state }
    }
    return nil
  }

  return walk(window, depth: 0)
}

private func waitForInitialAppState(timeout: TimeInterval) -> InitialAppState {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if let state = initialAppState() { return state }
    Thread.sleep(forTimeInterval: 1)
  }
  fail("Synq native UI did not leave its loading shell")
}

private func waitForButton(_ target: String, timeout: TimeInterval) -> AXUIElement {
  let deadline = Date().addingTimeInterval(timeout)
  while Date() < deadline {
    if let match = button(named: target) { return match }
    Thread.sleep(forTimeInterval: pollInterval)
  }
  fail("Synq native UI button did not appear: \(target)")
}

private func press(_ target: String, timeout: TimeInterval) {
  let match = waitForButton(target, timeout: timeout)
  let result = AXUIElementPerformAction(match, kAXPressAction as CFString)
  guard result == .success else {
    fail("Synq native UI button press failed for \(target): AXError \(result.rawValue)")
  }
}

private func cgPoint(_ element: AXUIElement) -> CGPoint? {
  guard let raw = attribute(element, kAXPositionAttribute),
        CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
  let value = unsafeBitCast(raw, to: AXValue.self)
  var point = CGPoint.zero
  guard AXValueGetValue(value, .cgPoint, &point) else { return nil }
  return point
}

private func cgSize(_ element: AXUIElement) -> CGSize? {
  guard let raw = attribute(element, kAXSizeAttribute),
        CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
  let value = unsafeBitCast(raw, to: AXValue.self)
  var size = CGSize.zero
  guard AXValueGetValue(value, .cgSize, &size) else { return nil }
  return size
}

private func nativeWindowID(ownerPid: pid_t) -> Int? {
  let rawWindows = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    kCGNullWindowID,
  ) as? [[String: Any]] ?? []

  for window in rawWindows {
    let pid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
    let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue
    let number = (window[kCGWindowNumber as String] as? NSNumber)?.intValue
    guard pid == ownerPid, layer == 0, let number else { continue }
    guard let rawBounds = window[kCGWindowBounds as String] as? NSDictionary,
          let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
          bounds.width >= 960,
          bounds.height >= 680 else { continue }
    return number
  }
  return nil
}

private func printWindowEvidence(_ window: AXUIElement, prefix: String) {
  guard let point = cgPoint(window), let size = cgSize(window) else {
    fail("could not read Synq native window bounds")
  }
  guard let windowID = nativeWindowID(ownerPid: pid_t(rawPid)) else {
    fail("could not resolve the Synq CoreGraphics window id")
  }
  let title = stringAttribute(window, kAXTitleAttribute)
  guard title == "Synq" else {
    fail("unexpected Synq native window title: \(title.isEmpty ? "<empty>" : title)")
  }
  let fields = [
    prefix,
    "ax",
    title,
    String(Int(point.x.rounded())),
    String(Int(point.y.rounded())),
    String(Int(size.width.rounded())),
    String(Int(size.height.rounded())),
    String(windowID),
  ]
  print(fields.joined(separator: "\t"))
}

let frontmostResult = AXUIElementSetAttributeValue(
  app,
  kAXFrontmostAttribute as CFString,
  kCFBooleanTrue,
)
guard frontmostResult == .success else {
  fail("could not bring the exact Synq process to the foreground: AXError \(frontmostResult.rawValue)")
}

let initialWindow = waitForWindow(timeout: 15)

if startupErrorMode {
  waitForExactText("Synq 无法启动本地服务", timeout: 15)
  printWindowEvidence(firstWindow() ?? initialWindow, prefix: "native-startup-error-ok")
  exit(0)
}

switch waitForInitialAppState(timeout: 15) {
case .onboarding:
  let detectionDeadline = Date().addingTimeInterval(15)
  while Date() < detectionDeadline {
    if hasExactText("已找到") || hasExactText("未检测到") { break }
    Thread.sleep(forTimeInterval: pollInterval)
  }
  guard hasExactText("已找到") || hasExactText("未检测到") else {
    fail("Synq native Agent detection did not resolve")
  }
  press("查看演示", timeout: 10)
case .dashboard:
  break
}

press("设置", timeout: 15)
waitForExactText("本机监控", timeout: 10)

let finalWindow = firstWindow() ?? initialWindow
printWindowEvidence(finalWindow, prefix: "native-ui-ok")
