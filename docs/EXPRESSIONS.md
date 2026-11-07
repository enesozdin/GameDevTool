# Expression Language

One small language is shared by every tool: production gates, recipe unlock conditions
and table formulas today, and later dialogue conditions and loot rules. It is
parsed and compiled by our own code (`src/core/expr`). Expressions are never run as
JavaScript, so project files cannot execute code.

This page is the specification. Engine-side interpreters (for exported dialogue and
loot rules) should follow it.

## Examples

    Level >= 5 and HasForge
    MainQuest == "Done" or not TutorialActive
    clamp(Gold / 100, 0, 10) > 2
    if(Difficulty == "Hard", 1.5, 1) * BaseDamage
    Base * Weapon.Material.Mult * (1 + Level * 0.1)      (table formula)

## Values and types

| Type | Literals | Notes |
|---|---|---|
| `bool` | `true`, `false` | |
| `number` | `3`, `0.25`, `.5`, `1e3`, `2.5E-2` | IEEE 754 double. `int` and `float` variables are both `number`. |
| `string` | `"Iron \"Ore\""` | Double quotes. Escapes: `\"` `\\` `\n` `\t`. One line. |
| enum | (option name in quotes) | A value of one enum variable. |

There are no implicit conversions: `HasKey + 1` and `Level == "3"` are type errors.

## Names

- A name refers to a **project variable** (Project overview → Variables).
- Names are **case-insensitive**: `level`, `Level` and `LEVEL` are the same variable.
  This matches the case-insensitive uniqueness of identifiers and Unreal `FName`s.
- Keywords `and`, `or`, `not`, `true`, `false` are reserved (also case-insensitive)
  and cannot be used as variable names.
- Renaming a variable rewrites every condition and formula that uses it.
- In table formulas, names are column names first (see [Table formulas](#table-formulas)),
  and `a.b` reads a column through a reference column. Elsewhere `.` is a syntax error.

### Enum variables

An enum variable (e.g. a quest state) is compared with the **name of one of its options**
in quotes: `MainQuest == "Done"`. The name is resolved when the expression is compiled,
so an unknown option is reported before anything runs. Option names are also matched
case-insensitively. At run time enum values are option ids.

## Operators

From lowest to highest precedence:

| Precedence | Operators | Types | Associativity |
|---|---|---|---|
| 1 | `or`, `\|\|` | bool | left |
| 2 | `and`, `&&` | bool | left |
| 3 | `not`, `!` (prefix) | bool | right |
| 4 | `==` `!=` | two values of the same type | none |
| 4 | `<` `<=` `>` `>=` | number | none |
| 5 | `+` `-` | number; `+` also joins two strings | left |
| 6 | `*` `/` `%` | number | left |
| 7 | `-` (prefix) | number | right |
| 8 | `^` (power) | number | right |

Notes:

- `not` binds **looser** than comparisons (as in Python): `not Level >= 5` means
  `not (Level >= 5)`. The same holds for `!`.
- Comparisons do not chain: `1 < x < 3` is an error. Write `1 < x and x < 3`.
- `^` binds tighter than prefix minus: `-2 ^ 2` is `-4`. `2 ^ 3 ^ 2` is `2 ^ 9`.
- `and` and `or` short-circuit.
- `%` is the remainder with the sign of the left operand (`-7 % 3` is `-1`).

## Functions

The function list is fixed for the MVP and grows only on real needs. Function names
are case-insensitive.

| Function | Result |
|---|---|
| `if(cond, a, b)` | `a` when `cond` is true, else `b`. Only the chosen branch is evaluated, so `if(x != 0, 1 / x, 0)` is safe. `a` and `b` must have the same type. |
| `min(a, b, …)` | Smallest argument (one or more). |
| `max(a, b, …)` | Largest argument (one or more). |
| `clamp(x, lo, hi)` | `x` limited to `[lo, hi]`; `lo` wins when `lo > hi`. |
| `lerp(a, b, t)` | `a + (b - a) * t`; `t` is not clamped. |
| `abs(x)` | Absolute value. |
| `floor(x)`, `ceil(x)` | Round down / up. |
| `round(x)` | Nearest integer; halves round up (`round(2.5)` = 3, `round(-2.5)` = -2), like Unreal's `FMath::RoundToFloat`. |
| `sqrt(x)` | Square root. |
| `pow(x, y)` | Same as `x ^ y`. |

## Errors

Compile errors are found before anything runs; each carries a stable code and a
character range, which the editor underlines and the validation list shows.

| Code | Meaning |
|---|---|
| `expr-empty` | No expression. |
| `expr-too-long` | More than 10 000 characters. |
| `expr-too-deep` | Nested more than 256 levels. Parentheses, `not`, unary minus and calls count one level each, and so does every binary operator in a chain: `a + b + c` is two levels. |
| `expr-unexpected-char` | A character that is not part of the language, e.g. `$`. |
| `expr-unterminated-string`, `expr-bad-escape` | Broken text literal. |
| `expr-bad-number` | Malformed number, e.g. `1.2.3`, `2x`, `1e`. |
| `expr-unexpected-token`, `expr-expected` | Syntax error. |
| `expr-chained-comparison` | `a < b < c`. |
| `expr-unknown-name`, `expr-unknown-function` | Name not found. |
| `expr-arg-count` | Wrong number of arguments. |
| `expr-type` | Wrong type, including a condition that is not `bool`. |
| `expr-unknown-option` | Enum compared with a name that is not one of its options. |
| `expr-unknown-column` | `Ref.Name`: the referenced table has no column `Name`. |
| `expr-not-reference` | `X.Name` where `X` is not a reference column. |
| `expr-needs-column` | A reference column used as a value (`Weapon` instead of `Weapon.Damage`). |
| `expr-unsupported-column` | A list, item amounts or curve column, which formulas cannot read. |
| `expr-cycle` | The formula depends on its own column (directly, through other formulas, or through a reference). |
| `expr-input-error` | The formula reads a formula column that has one of these errors. |

Run-time errors stop the evaluation and return an error instead of a value:

| Code | Meaning |
|---|---|
| `expr-division-by-zero` | `/` or `%` by zero. |
| `expr-not-finite` | A result that is infinite or not a number, e.g. `10 ^ 400`, `sqrt(-1)`. |
| `expr-not-integer` | A formula in an Integer column gave a fraction; use `round`, `floor` or `ceil`. |
| `expr-input-error` | A formula cell reads a formula cell that has a run-time error. |

## Where expressions are used

| Place | Expected type | Empty means |
|---|---|---|
| Gate node condition (production chain) | bool | Warning: gate has no condition. |
| Recipe `Gate` column (unlock condition) | bool | Always unlocked. |
| Column formula (any table) | number (Integer, Number columns), text, bool | No formula: cells are stored values. |

### Gates in the calculation

The production chain is calculated with a **scenario**: every variable at its start
value, unless the designer changes it in the editor's Scenario panel. Scenario values are
saved with each chain (so one chain can show the early game and another the late game),
can be undone, and never change the variables' start values. Against these values:

- a gate node whose condition is false passes nothing;
- a recipe whose unlock condition is false does not run;
- a condition with an error (compile or run time) counts as false.

Locked nodes run at 0 in both calculation modes and in every Monte Carlo run. In
target-driven mode the demand moves to the other, open suppliers of the same input; if
there are none, the consumer shows a deficit. In supply-driven mode the locked node is the
limit, and the bottleneck, of everything downstream. "Treat all gates as open" calculates
the chain as if everything were unlocked.

### Unlock order check

The production chain validation warns when a recipe **can be unlocked before one of
its inputs**. Every node gets the conditions that must hold before anything flows out of
it: a gate adds its condition, a recipe adds its unlock condition and those of all its
inputs, and an input with several suppliers only needs what they all share. A recipe
with an unlock condition is reported when that condition does not imply what an input
needs.

Implication is decided per `and` term. A term implies another when both are the same
(after canonical printing) or when both compare one variable with a number and the
first range lies inside the second: `Level >= 5` implies `Level > 3`, `Level == 7`
implies `Level != 3`. `or` terms and other forms count only when they match exactly, so
the check may miss an implication but never invents one. Recipes without an unlock
condition are not reported; they become usable together with their inputs.

## Table formulas

A column of type Integer, Number, Text (plain) or Yes/No can have a **formula**. Its
cells are then computed for every row and never stored; the grid shows them in italics
with a ƒx mark on the column, and the formula bar above the grid edits the formula of the
active cell's column. Examples:

    Base * (1 + Level * 0.1)                  same-row column Base, variable Level
    round(Hp * Difficulty.HpScale)            Difficulty is a reference column
    if(Rarity == "Rare", 2, 1) * Weapon.Material.Mult
    Title + " (" + Weapon.Title + ")"         text columns join with +

**Names** resolve in this order:

1. a column of the formula's own table, read from the **same row** (case-insensitive);
2. a project variable, at its **start value**.

A column hides a variable with the same name in that table's formulas.

**Cross-table lookups** go through reference columns: `Weapon.Damage` reads the Damage
column of the row the Weapon cell points to, and chains follow further references
(`Weapon.Material.Density`). Only names can be chained; `f(x).y` is a syntax error.

| Column type | Value in a formula |
|---|---|
| Integer, Number | number |
| Text (plain), Text (localizable) | text (localizable text reads its source text) |
| Yes/No | bool |
| Choice (enum) | enum; compare with an option name: `Rarity == "Rare"` |
| Row of a table (reference) | only with `.Column` |
| List, item amounts, curve | not readable (`expr-unsupported-column`) |

**Empty values.** An empty cell reads as `0`, `""` or `false` (an empty enum cell equals no
option). An empty or broken reference reads every column of its row as empty. A cell
whose stored value does not fit its column (validation reports it) also reads as empty.

**Result type.** The formula must give the column's type: a number for Integer and
Number, text for Text, bool for Yes/No (`expr-type` otherwise). In an Integer column, a
fraction is a cell error (`expr-not-integer`).

**Errors.** A formula that does not compile, has the wrong type or is part of a cycle
fails for the whole column; formula columns reading it fail with `expr-input-error`.
Run-time errors (division by zero, …) fail single cells, shown as `#ERROR` with the message
on hover and in the formula bar, and cells reading them fail too. Validation lists one
issue per column and kind of problem. Column constraints (min/max, unique, max length)
apply to computed values.

**Cycles** are found per column: a formula may not read its own column, not even through
a reference into the same table (`Parent.Hp` in an Hp formula), although rows could form
a tree. Formulas across tables are evaluated in dependency order.

**Editing.** Saving the first formula of a column removes its stored values (the app asks
first). Removing a formula (clear the formula bar) keeps the computed values as plain
values. Both are one undo step. Paste, fill down and clear skip formula cells; copy takes
the computed values. Renaming a column or a variable rewrites the formulas that use it,
also `Ref.Column` references from other tables.

**Exports** write the computed values: CSV import skips formula columns, and engines see
plain data. Columns used by a table role (recipe time, machine speed, …) cannot have a
formula, because the production tools read their stored values.

**Recalculation.** All formula columns of a project form one dependency graph. After an
edit, a formula column whose inputs did not change keeps its results; one that reads only
its own row recalculates just the rows that changed; one that reads other rows (through
references) recalculates its whole column when those tables change. The work runs on the
main thread: numbers are kept in typed arrays, and an edit usually touches few rows.

## Implementation notes

- Tokenizer → recursive-descent parser → AST → type checker that compiles to closures.
  Names resolve to array slots at compile time, so evaluating reads an array and runs no
  type checks. Table formulas fill the slots per row (`src/core/formulas.ts`): each
  distinct name, including each `a.b.c` chain, is one slot.
- Compiled conditions are cached by source text per project snapshot.
- Canonical printing (`printExpression`) normalizes spacing, parentheses, keyword
  aliases and name spelling; the unlock order check compares terms by this text.
