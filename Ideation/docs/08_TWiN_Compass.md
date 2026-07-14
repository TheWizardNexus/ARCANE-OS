# TWiN Compass™

## Role

TWiN Compass is the moral, ethical, policy, and governance foundation beneath ARCANE.

It does not merely produce advice. It provides hooks through which the runtime can:

- permit;
- deny;
- constrain;
- request confirmation;
- escalate;
- redact;
- log;
- require review.

## Core Values

- **Integrity** — do what is right and preserve truth.
- **Fairness** — treat people equitably and recognize context.
- **Compassion** — preserve human dignity and well-being.
- **Accountability** — make decisions traceable and answerable.
- **Sustainability** — protect long-term human, social, and environmental interests.

## Architectural Placement

TWiN Compass sits beneath memory and capabilities because:

- memory promotion must be governed;
- capability use must be governed;
- planning must be governed;
- reporting and data movement must be governed.

It should be accessible through a stable policy interface rather than embedded inconsistently throughout application code.

## Policy Flow

```text
Intent
  ↓
Proposed plan
  ↓
Capability and data requirements
  ↓
TWiN Compass evaluation
  ↓
Allow / constrain / confirm / deny / escalate
  ↓
Execution
  ↓
Audit and outcome evaluation
```

## Core Narrative

Knowledge without ethics is dangerous.

Ethics without capability is ineffective.

Together they become wisdom.
