# Expression Language

One small language is shared by every tool: production gates and recipe unlock
conditions today, and later table formulas, dialogue conditions and loot rules. It is
parsed and compiled by our own code (`src/core/expr`). Expressions are never run as
JavaScript, so project files cannot execute code.

This page is the specification. Engine-side interpreters (for exported dialogue and
loot rules) should follow it.

## Examples

    Level >= 5 and HasForge
    MainQuest == "Done" or not TutorialActive
    clamp(Gold / 100, 0, 10) > 2
    if(Difficulty == "Hard", 1.5, 1) * BaseDamage

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
- Renaming a variable rewrites every condition that uses it.

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

Run-time errors stop the evaluation and return an error instead of a value:

| Code | Meaning |
|---|---|
| `expr-division-by-zero` | `/` or `%` by zero. |
| `expr-not-finite` | A result that is infinite or not a number, e.g. `10 ^ 400`, `sqrt(-1)`. |

## Where expressions are used

| Place | Expected type | Empty means |
|---|---|---|
| Gate node condition (production chain) | bool | Warning: gate has no condition. |
| Recipe `Gate` column (unlock condition) | bool | Always unlocked. |

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

## Implementation notes

- Tokenizer → recursive-descent parser → AST → type checker that compiles to closures.
  Names resolve to array slots at compile time, so evaluating reads an array and runs no
  type checks.
- Compiled conditions are cached by source text per project snapshot.
- Canonical printing (`printExpression`) normalizes spacing, parentheses, keyword
  aliases and name spelling; the unlock order check compares terms by this text.
