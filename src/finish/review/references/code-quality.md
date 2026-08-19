# Code quality & test integrity dimension

Reference for the post-impl-review **code-quality** pass: spec-independent
defects and design/maintainability concerns in the changed lines. These findings
are real regardless of what the spec says. Scan the diff — production **and**
test code — and judge each changed function on its own merits.

## Forcing function — enumerate before you conclude

Before reporting, walk **every function/method the diff adds or changes** and
write yourself a one-line verdict for each: *earns its place* or *concern: …*.
This enumeration is a thinking tool — it does not go in the final report, only
the resulting findings do. Skipping it is how real maintainability issues get
missed: an agent that pattern-matches a few obvious smells and stops will always
under-report. Look at each changed function deliberately.

## What to look for

Report only concrete, objective issues, not style preferences:

- **Test isolation:** mutating `os.environ` / globals / singletons / filesystem
  without teardown; cross-test ordering dependence; shared mutable fixtures. A
  test that only passes because another test happens to clean up after it is a
  defect even when the suite is currently green.
- **Dead / redundant code:** assignments with no effect, unreachable branches,
  set-up the constructor already performed, unused locals introduced by the diff;
  logic duplicated from an existing helper the diff could have reused.
- **Resource leaks:** opened files / sockets / handles / subprocesses not closed;
  timers / listeners not cleared.
- **Error handling:** swallowed exceptions, bare catches that hide failures,
  missing validation on a newly-introduced input path.
- **Concurrency:** shared state mutated without synchronisation; `await` inside a
  loop that should be batched; a race between a check and the action it guards.
- **Performance:** N+1 queries or network calls in a loop; blocking I/O on a hot
  path; an obviously quadratic scan over a large collection the diff introduces.
- **Accessibility (UI diffs only):** interactive elements without an accessible
  name/label, missing `alt`, non-keyboard-reachable controls, form inputs with
  no associated label.
- **Security (only when the diff touches it):** hardcoded secrets, unvalidated
  user input reaching a sink, injection vectors.
- **Type safety:** unsafe casts, `any`/`unknown` escapes, weakened or widened
  types the diff introduces, or a narrowing the diff drops — anywhere the change
  trades a compile-time guarantee for a runtime risk.
- **Design & maintainability (open-ended — not a closed checklist):** a changed
  function that conflates multiple responsibilities (poor separation of
  concerns); an abstraction the diff introduces that is premature (single caller,
  speculative generality) or leaky (callers must understand its internals to use
  it safely); logic the diff writes inline that an existing helper already
  provides (reinvention, not just literal duplication); control flow so nested or
  convoluted the next reader will misread it; an identifier whose name actively
  misleads about what it holds or does; a comment or docstring the diff now leaves
  stale or contradicting the code it sits on, or a changed public API left without
  the docs a caller needs; an edge case the changed code's *own* logic implies but
  doesn't handle. These are the qualitative "this code isn't good yet" findings —
  judge them, don't skip them because they aren't on the defect list above. Anchor
  each to the changed line and state the concrete cost (what breaks, or who is
  misled, later).

Every finding here must point at a specific changed line and name a concrete cost
— a bug, a future break, or a reader who will be misled. Skip pure formatting and
personal taste that carry no such cost, and skip hypotheticals about code outside
the diff. But a design or maintainability concern grounded in a changed line and
its cost **is** in scope even though it's not on the defect checklist above —
that is exactly the signal this dimension exists to surface.

## Confidence threshold (code quality)

**Report findings you are ≥60% confident are real**, *provided* each is anchored
to a specific changed line and names a concrete maintenance or correctness cost.
Design and maintainability problems are inherently probabilistic — a muddy
abstraction, a misleading name, or a fragile edge case rarely clears 80%, and a
blanket 80% gate is precisely what makes a review miss the quality issues it
exists to catch. Let these land as MEDIUM or LOW per the severity table rather
than dropping them; the implementer can waive them, but they should see them.
Still exclude pure formatting and personal taste that carry no stated cost. Do
**not** over-suppress this tier to hit an arbitrary count — a real
maintainability concern stated with its cost is worth surfacing even at moderate
confidence.
