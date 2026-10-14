# Agent Requirements Brief: <Task Name>

## 1) Context snapshot (from this conversation)

- <What we already agreed on>
- <Key constraints / definitions>
- <Why now / what triggered this>

## 2) Background

<What is the current situation? What led to this request?>

## 3) Problem statement

<1–3 sentences: what is wrong/missing, who it affects, why it matters.>

## 4) Goals

### MUST
- <Goal>

### SHOULD
- <Goal>

### COULD
- <Goal>

## 5) Non-goals / out of scope

- <Non-goal>

## 6) Deliverables

- <Artifact 1>
- <Artifact 2>

**Assumed base ref (if starting from mainline):** `<e.g. origin/main>`

## 6.1) Project references (do not duplicate)

- `<README.md>`
- `<docs/...>`

## 7) Agent data spec

### Inputs

**Source(s)**
- <File/DB/API + owner + access method>

**Format**
- <CSV/JSON/Parquet/...; encoding/compression>

**Schema**
- `<field>`: <type> (<required/optional>) — <meaning/validation>

**Volume & freshness**
- Size: <approx>
- Update frequency: <daily/weekly/...>
- Time range: <...>

**Quality notes**
- <duplicates/missing values/canonical IDs/join keys>

**Security & privacy**
- PII: <none/low/medium/high; details>
- Retention: <...>
- Redaction: <...>

**Example**
```json
{ "example": "replace me" }
```

### Transformations (if any)

- <Normalization / mapping / dedupe rules>

### Outputs

**Artifacts**
- Path/name: `<...>`
- Format/schema: <...>
- Consumers: <who/what uses it>

**Success metrics (optional)**
- <metric + target>

## 8) Interfaces & integration points

- <APIs / DB tables / events / services>
- Contract expectations: <inputs/outputs/errors>

## 9) Acceptance criteria (definition of done)

### Core path
- [ ] Given <context>, when <action>, then <expected outcome>.

### Edge cases
- [ ] <Edge case>

### Verification
- [ ] <How we verify locally/CI/prod>

## 10) Constraints

- Platforms/compat: <...>
- Performance: <...>
- Compliance/security: <...>
- Rollout/migration: <...>
- Deadline: <...>

## 11) Open questions

- <Question>

## 12) Optional: suggested approach

- <High-level plan>
- Risks: <...>
- Tradeoffs: <...>
