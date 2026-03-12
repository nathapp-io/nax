# Prompts

Exported prompts from nax CLI (`nax prompts --export`).

## Roles

```
prompts/roles/
├── implementer.md        # nax prompts --export implementer
├── implementer-lite.md   # variant (CLI doesn't support --variant yet)
├── test-writer.md        # nax prompts --export test-writer
├── verifier.md           # nax prompts --export verifier
├── single-session.md     # nax prompts --export single-session
└── tdd-simple.md         # nax prompts --export tdd-simple
```

## Sections

```
prompts/sections/
├── isolation.md    # Isolation rules for all roles
└── conventions.md # Conventions section
```

## Usage

Use as overrides in `nax.config.json`:

```json
{
  "prompts": {
    "overrides": {
      "implementer": "prompts/roles/implementer.md",
      "test-writer": "prompts/roles/test-writer.md"
    }
  }
}
```

## Re-export

To re-export after changes to source:

```bash
nax prompts --export implementer --out prompts/roles/implementer.md
nax prompts --export test-writer --out prompts/roles/test-writer.md
nax prompts --export verifier --out prompts/roles/verifier.md
nax prompts --export single-session --out prompts/roles/single-session.md
nax prompts --export tdd-simple --out prompts/roles/tdd-simple.md
```

Note: `--variant lite` is not yet supported in CLI. `implementer-lite.md` was created manually.
