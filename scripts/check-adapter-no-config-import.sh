#!/usr/bin/env bash
# Fail if any file under src/agents/{acp,native}/ reads NaxConfig or CompleteConfig from complete() options,
# or imports NaxConfig / DEFAULT_CONFIG / config loader directly.
# This enforces the adapter boundary: adapters receive a resolved ModelDef, not raw NaxConfig.
#
# Note: imports of pure primitive types (ModelDef, ModelTier) from config/schema are permitted —
# only NaxConfig, CompleteConfig, defaults, and loader are banned.
set -euo pipefail

scan_dirs="src/agents/acp/ src/agents/native/"

# Block direct NaxConfig / CompleteConfig / DEFAULT_CONFIG imports (structural config reads)
banned_imports=$(grep -r "import.*\(NaxConfig\|CompleteConfig\|DEFAULT_CONFIG\)" $scan_dirs --include="*.ts" 2>/dev/null || true)
# Block imports from config/defaults or config/loader
defaults_loader=$(grep -r "import.*config/\(defaults\|loader\)" $scan_dirs --include="*.ts" 2>/dev/null || true)
# Block options?.config or _options.config access in adapter (old CompleteOptions.config pattern)
options_config=$(grep -r "options\?\?\.config\b\|_options\.config\b\|options\.config\b" $scan_dirs --include="*.ts" 2>/dev/null || true)

if [ -n "$banned_imports" ] || [ -n "$defaults_loader" ] || [ -n "$options_config" ]; then
  echo "ERROR: adapter implementations in $scan_dirs must not import NaxConfig/CompleteConfig/DEFAULT_CONFIG or access options.config:"
  [ -n "$banned_imports" ] && echo "$banned_imports"
  [ -n "$defaults_loader" ] && echo "$defaults_loader"
  [ -n "$options_config" ] && echo "$options_config"
  exit 1
fi
echo "OK: Adapter implementations use only resolved primitives (no NaxConfig reads)"
