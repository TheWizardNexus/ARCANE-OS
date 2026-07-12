# Security, Identity, and Memory

## Security Principle

Security must be enforced by architecture and the operating system, not by prompts.

## Identity

Keep the System Platform's login and authentication.

On Windows:

- retain Winlogon;
- use local or domain accounts;
- let Windows create per-user profiles;
- use Windows groups for machine roles;
- use ACLs for access enforcement.

## Suggested Roles

- **Participant / User** — may access only their own assessment or workspace.
- **Clinician / Authorized Reviewer** — may access all designated assessment records without receiving full machine administration.
- **ARCANE Administrator** — provisions the environment and manages the baseline.
- **Service Identity** — narrowly scoped account used only when cross-profile mediation is unavoidable.

## Data Placement

```text
Program Files/
└── ARCANE binaries and immutable assets

ProgramData/
└── Machine-wide non-personal state, signed packages, model inventory,
    device inventory, audit configuration, and shared operational metadata

Users/<user>/AppData/
└── Private user memory, conversations, preferences, and local workspace
```

Do not allow normal operation to write executable code into Program Files.

## Clinician Access

Where clinicians must access every participant assessment:

- create a dedicated Windows local group;
- grant that group access only to ARCANE assessment folders;
- apply the ACL through a controlled folder-creation process;
- avoid broad local Administrator membership where possible;
- audit access.

Do not rely on modifying the entire Windows profile template unless deployment testing proves the inheritance behavior is reliable and supportable. A safer pattern is for the provisioner to create the ARCANE data directory with the correct ACL whenever it provisions a participant.

## Memory Scopes

Every memory record must include:

- scope;
- owner;
- provenance;
- creation time;
- source;
- confidence;
- retention class;
- sensitivity class;
- permitted consumers;
- promotion state.

## Global Learning

Do not allow model output to write directly into global operational memory.

Use:

1. observation;
2. proposal;
3. deduplication;
4. evidence accumulation;
5. deterministic review;
6. policy validation;
7. controlled promotion.

This is similar to a scientific backlog or a human scratchpad. Suggestions can accumulate evidence without silently changing the core identity or rules.

## Privacy

A participant number is still sensitive when it can be linked to an individual.

Separate:

- the identity mapping;
- participant records;
- reports;
- aggregate research outputs;
- operational logs.

Reports leaving the private scope must pass through deterministic de-identification and authorization controls.
