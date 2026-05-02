#!/usr/bin/env bash
# Fail if any file under src/agents/acp/ reads NaxConfig or CompleteConfig from complete() options,
# or imports NaxConfig / DEFAULT_CONFIG / config loader directly.
# This enforces the adapter boundary: ACP adapter receives a resolved ModelDef, not raw NaxConfig.
#
# Note: imports of pure primitive types (ModelDef, ModelTier) from config/schema are permitted —
# only NaxConfig, CompleteConfig, defaults, and loader are banned.
set -euo pipefail

# Block direct NaxConfig / CompleteConfig / DEFAULT_CONFIG imports (structural config reads)
banned_imports=$(grep -r "import.*\(NaxConfig\|CompleteConfig\|DEFAULT_CONFIG\)" src/agents/acp/ --include="*.ts" 2>/dev/null || true)
# Block imports from config/defaults or config/loader
defaults_loader=$(grep -r "import.*config/\(defaults\|loader\)" src/agents/acp/ --include="*.ts" 2>/dev/null || true)
# Block options?.config or _options.config access in adapter (old CompleteOptions.config pattern)
options_config=$(grep -r "options\?\?\.config\b\|_options\.config\b\|options\.config\b" src/agents/acp/ --include="*.ts" 2>/dev/null || true)

if [ -n "$banned_imports" ] || [ -n "$defaults_loader" ] || [ -n "$options_config" ]; then
  echo "ERROR: src/agents/acp/ must not import NaxConfig/CompleteConfig/DEFAULT_CONFIG or access options.config:"
  [ -n "$banned_imports" ] && echo "$banned_imports"
  [ -n "$defaults_loader" ] && echo "$defaults_loader"
  [ -n "$options_config" ] && echo "$options_config"
  exit 1
fi
echo "OK: ACP adapter uses only resolved primitives (no NaxConfig reads)"
