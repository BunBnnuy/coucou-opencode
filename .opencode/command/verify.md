---
description: Run the Windows build, the Rust tests and the OpenCode plugin tests
---

Run every check the repo has. The Windows build first (its `prebuild` step
produces the release relay the Rust tests link against):

```bash
cd windows && npm install && npm run build && cargo test
```

Then, from the repository root, the OpenCode plugin translation tests:

```bash
node --test "tests/opencode/*.test.ts"
```

Summarise what passed and what failed. Do not commit or push anything.
