# Provisioning, Installer, and Controlled Baselines

## Provisioning Goal

An administrator starts with a standard Windows installation, runs one trusted ARCANE provisioner, and reboots into the ARCANE experience.

## Provisioner Responsibilities

- validate OS edition, architecture, disk, memory, GPU, and policy prerequisites;
- install ARCANE binaries into Program Files;
- install immutable UI assets;
- install and validate the chosen local model runtime;
- import approved models;
- create local groups;
- create service identities when required;
- create data directories;
- apply ACLs;
- configure ARCANE as the shell for selected users;
- create an administrator maintenance path;
- register services or scheduled startup components;
- configure firewall policy;
- initialize signed configuration;
- record the installed baseline;
- create rollback and recovery information;
- reboot only after validation succeeds.

## Shell Assignment

The ARCANE process should be assignable per user or role.

Normal users should never fall back to Explorer because ARCANE crashes. Automatic Explorer fallback creates a potential escape path.

Maintenance mode should require:

- an authenticated ARCANE Administrator;
- an explicit maintenance action;
- a logged transition;
- launching Explorer only in the already authenticated administrator context.

## Installation Transactions

The provisioner should use staged operations:

1. preflight;
2. snapshot relevant state;
3. stage files;
4. verify hashes and signatures;
5. create identities and directories;
6. apply ACLs;
7. configure services and shell;
8. run health checks;
9. commit;
10. reboot.

If any critical step fails, restore the previous configuration.

## Updates

Treat each approved deployment as a controlled baseline.

Update types should be separated:

- content;
- model;
- policy;
- capability;
- application;
- runtime;
- system security;
- ACL or identity configuration.

A clinician may be permitted to install signed content or model packages. Platform, runtime, shell, service, or security updates should require the ARCANE Administrator role.

Use the same signed package format for network and offline USB delivery.

## Regulated Deployments

For clinical, government, or safety-critical deployments:

- pin every dependency;
- record exact hashes;
- disable uncontrolled automatic updates;
- maintain a software bill of materials;
- retain audit records;
- validate each new baseline before release;
- support deterministic rollback.
