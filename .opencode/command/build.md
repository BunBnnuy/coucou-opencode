---
description: Regenerate the Xcode project and build the macOS app
---

Build the macOS app and report only the errors and warnings that matter.

```bash
cd NotchBuddy && xcodegen && xcodebuild -scheme NotchBuddy -configuration Debug build
```

`NotchBuddy/project.yml` is the source of truth for the Xcode project. Never edit
`NotchBuddy.xcodeproj` or any `*.pbxproj` by hand — change `project.yml` and run
`xcodegen`. If the build fails, fix the cause rather than the generated project.
