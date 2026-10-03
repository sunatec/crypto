## ADDED Requirements

### Requirement: Book price and role constraints

The engine SHALL implement audited strict boundaries, role sets, full-path rules, triangle geometry and adopted parent-child constraints using local book citations, and SHALL preserve OV-001 as a guideline.

#### Scenario: Strict boundary and override
- **WHEN** C equals five B, or Y equals X, or Y is below ninety percent W
- **THEN** the first two fail their strict rules and the third alone does not invalidate the double zigzag.

#### Scenario: Ambiguous shared pivot candle
- **WHEN** a path or movement-ratio decision depends on an extremum of the shared start candle whose event order is unknown
- **THEN** the condition remains pending until adopted finer observations resolve it, while a definite breach in a later candle still fails.

### Requirement: Special structures and degrees

The engine SHALL retain short C endpoints and expanding ending candidates and SHALL serialize author-specific Y/Z degrees independently of recursion depth. Missing expanding-diagonal source details SHALL remain pending.

#### Scenario: Short C
- **WHEN** a down zigzag has endpoints 100, 60, 80, 61
- **THEN** its root candidate interval can end at 61 rather than being universally cropped to 60.

### Requirement: Scoped evidence and completion

The engine SHALL adopt actual intraday structures, count proven direct roles consistently, provide explicit finest-resolution verification scope, and distinguish forming, potentially_complete, confirmed_complete and invalidated. Budget exhaustion and unknown leaves SHALL NOT prove roles.

#### Scenario: Unresolved child
- **WHEN** a candidate has no own price failures but a required child is unknown
- **THEN** the candidate remains pending and is not announced as confirmed complete.

### Requirement: Structure-derived consistent output

The engine SHALL derive current labels from the adopted structure and SHALL use identical labels and states in JSON and Markdown. Deferred in-progress rules SHALL affect the actual ranking score.

#### Scenario: Parent combination
- **WHEN** the parent is a combination but current internal structure is unknown
- **THEN** the renderer does not relabel unknown or ABC legs as WXY merely from that parent.

### Requirement: Unproven lower evidence does not erase known violations

A role violation found on the candidate's own timeframe SHALL remain a violation unless a lower timeframe returns verified evidence for that role. Pending, missing-data and search-limited lower results SHALL NOT convert the violation to pending.

#### Scenario: Daily C cannot be an impulse
- **WHEN** every daily reading of a zigzag C overlaps wave 4 into wave 1 and hourly data are unavailable
- **THEN** the zigzag keeps one grammar violation and is not reported as rules passed

#### Scenario: Lower timeframe proves the role
- **WHEN** the same C leg receives verified hourly evidence
- **THEN** the grammar violation is lifted

### Requirement: Origin and orthodox-end limits

A driving leg SHALL NOT contain a price beyond its own origin. A corrective leg MAY exceed its origin only when the excursion is smaller than its prior move in the leg direction (b' < 2a'). Orthodox endpoints beyond the global extreme SHALL be considered only for impulse, zigzag and flat candidates that contain the global extreme as an internal point.

#### Scenario: Hidden high inside fifth wave
- **WHEN** a down impulse places wave 4 at 76022.6 while 82814.23 occurs inside wave 5
- **THEN** the candidate is not generated

#### Scenario: Current bounce absorbed into history
- **WHEN** a combination would end at a pullback low inside the bounce after the global extreme
- **THEN** it is not offered as a completed historical structure
