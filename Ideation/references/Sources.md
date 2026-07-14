# Technical References

These references are included for implementation research. Pin the exact Node.js version used by the project and review the matching documentation for that version.

## Node.js

- Single Executable Applications  
  https://nodejs.org/api/single-executable-applications.html

- Node.js Permission Model  
  https://nodejs.org/api/permissions.html

- Node.js CLI, including `--build-sea` in current documentation  
  https://nodejs.org/api/cli.html

- Child Processes  
  https://nodejs.org/api/child_process.html

- Node-API  
  https://nodejs.org/api/n-api.html

- VM module warning: `node:vm` is not a security mechanism  
  https://nodejs.org/api/vm.html

## Notes

- The Single Executable Applications feature supports injecting an application blob into the Node binary.
- Current Node documentation describes the Permission Model as stable.
- Current documentation describes the newer direct `--build-sea` command as active development; use a pinned toolchain and verify suitability before adopting it for a regulated baseline.
