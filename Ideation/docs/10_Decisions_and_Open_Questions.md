# Decisions and Open Questions

## Decisions

- Product name: **ARCANE**
- Parent company: **The Wizard Nexus**
- Brand phrase: **Where WiZdom Meets Innovation**
- Category: **AI-Native Operating Environment**
- Ethical foundation: **TWiN Compass™**
- Preferred implementation language: JavaScript / Node.js
- Preferred packaging: Node.js single executable
- System integration: typed System Platform Adapter
- Identity and access: use underlying OS accounts, groups, and ACLs
- UI: web technology is acceptable; renderer remains replaceable
- Security: capability-based and OS-enforced
- Normal-user crash behavior: never automatically expose Explorer
- Updates: controlled, signed, versioned baselines
- Product scope: foundational HMI environment, not a medical-only product

## Open Questions

### Renderer

- Which renderer should the Windows MVP use?
- Can it be hosted without importing an entire desktop framework?
- How will navigation be locked to local approved content?
- How will renderer crashes be isolated from the runtime?

### Shell Configuration

- Shell Launcher versus direct shell configuration for target Windows editions?
- Per-user shell policy?
- Recovery and maintenance workflow?
- Secure attention sequence behavior?

### Privilege Separation

- Is a separate privileged Windows service needed?
- Which actions can remain in the logged-in user's process?
- How should installation, updates, account creation, and ACL changes be brokered?

### Plugin Model

- Declarative capabilities only for MVP?
- Signed trusted JavaScript modules?
- Separate process isolation?
- WebAssembly plugin boundary?
- Package signing and revocation?

### Memory

- Encryption format?
- Per-user key handling?
- Machine-wide non-personal memory?
- Promotion algorithm for learned operational guidance?
- Retention and deletion policies?

### Model Runtime

- Ollama as initial provider?
- Alternative local providers?
- Model inventory and validation?
- GPU and CPU fallback?
- Deterministic baseline packaging?

### Deployment

- Supported Windows editions?
- Fully offline installer size?
- Image-based factory provisioning?
- Licensing model?
- Enterprise management and fleet reporting?
