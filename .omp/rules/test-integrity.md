---
condition: '\b(?:it|test|describe)\.(?:only|skip)\s*\(|\b(?:xit|xtest|xdescribe)\s*\('
scope: tool
interruptMode: always
---

Keep the contract active. Repair the implementation, or correct a demonstrably invalid test; never mute coverage to make a check pass. Run the owning check.