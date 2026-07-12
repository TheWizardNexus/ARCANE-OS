# ARCANE Reference Architecture

## Layer Model

```text
┌──────────────────────────────────────────────┐
│ Experience Layer                             │
│ Conversation, adaptive UI, accessibility     │
├──────────────────────────────────────────────┤
│ Intent Engine                                │
│ Goal interpretation, planning, routing       │
├──────────────────────────────────────────────┤
│ Capability Framework                         │
│ Approved tools, apps, devices, workflows     │
├──────────────────────────────────────────────┤
│ Memory System                                │
│ User, role, device, and organizational state │
├──────────────────────────────────────────────┤
│ TWiN Compass™                                │
│ Moral, ethical, policy, and safety guidance  │
├──────────────────────────────────────────────┤
│ ARCANE Runtime                               │
│ Lifecycle, events, identity, audit, IPC       │
├──────────────────────────────────────────────┤
│ System Platform Adapter                      │
│ Windows/Linux/device-specific implementation │
└──────────────────────────────────────────────┘
```

## Experience Layer

Responsibilities:

- conversation-first interaction;
- task and intent surfaces;
- multimodal input and output;
- accessibility adaptation;
- visual rendering;
- notifications and confirmations;
- role-appropriate views.

The experience layer must be replaceable and should not contain privileged system logic.

## Intent Engine

Responsibilities:

- translate user expressions into typed intents;
- resolve ambiguity;
- produce plans;
- select capabilities;
- request authorization;
- maintain execution context;
- explain proposed or completed actions.

## Capability Framework

A capability is a governed interface to an operation, not arbitrary code execution.

Examples:

- launch an approved application;
- locate a file;
- create a report;
- operate a camera;
- query a local model;
- provision a user;
- access a permitted data scope;
- print, export, or transfer an approved artifact.

Every capability should declare:

- identifier;
- version;
- scope;
- required role;
- required OS permissions;
- accepted input schema;
- output schema;
- audit behavior;
- network behavior;
- risk classification;
- TWiN Compass policy hooks.

## Memory System

Memory should remain separated by scope:

- user memory;
- role memory;
- machine memory;
- organizational memory;
- immutable policy;
- proposed learning backlog.

No plugin or model chooses its own storage scope.

## TWiN Compass™

TWiN Compass provides guidance and enforceable policy hooks for:

- integrity;
- fairness;
- compassion;
- accountability;
- sustainability;
- deployment-specific policy;
- data handling;
- escalation;
- report generation;
- memory promotion.

## Runtime

The runtime coordinates:

- startup and shutdown;
- authentication context;
- capability registration;
- process supervision;
- IPC;
- local API hosting;
- model provider management;
- event bus;
- configuration;
- logging and audit;
- package verification;
- safe recovery.

## System Platform Adapter

The platform adapter exposes only the lower-level functionality ARCANE requires.

Examples on Windows:

- local accounts and groups;
- ACL management;
- shell configuration;
- process creation;
- services;
- registry;
- event logs;
- device access;
- file-system operations;
- update staging;
- power and session controls.

The rest of ARCANE should not depend directly on Windows-specific details.
