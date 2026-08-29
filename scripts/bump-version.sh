#!/usr/bin/env bash
# =============================================================================
# ISMS Builder — Version Bump Script
# Aktualisiert die Versionsnummer in allen relevanten Dateien.
#
# Verwendung:
#   bash scripts/bump-version.sh 1.30
#   bash scripts/bump-version.sh 1.30.1
# =============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

NEW_VERSION="${1:-}"
if [[ -z "$NEW_VERSION" ]]; then
  echo "Verwendung: bash scripts/bump-version.sh <version>"
  echo "Beispiel:   bash scripts/bump-version.sh 1.30"
  exit 1
fi

# Kurze Version (z.B. 1.30) und volle Version (z.B. 1.30.0)
SHORT="${NEW_VERSION%.*}"
[[ "$NEW_VERSION" =~ \. ]] && SHORT_VER="$NEW_VERSION" || SHORT_VER="$NEW_VERSION"
FULL_VER="${NEW_VERSION}"
# Falls nur Major.Minor angegeben: .0 ergänzen für package.json
if [[ "${NEW_VERSION}" =~ ^[0-9]+\.[0-9]+$ ]]; then
  FULL_VER="${NEW_VERSION}.0"
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $*"; }
info() { echo -e "${BLUE}→${NC} $*"; }

# Aktuelle Version aus package.json lesen
OLD_FULL=$(node -p "require('./package.json').version" 2>/dev/null || echo "?")
OLD_SHORT=$(echo "$OLD_FULL" | sed 's/\.[0-9]*$//')

echo ""
echo "Version bump: ${OLD_FULL} → ${FULL_VER}"
echo ""

# 1. package.json
info "package.json..."
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json','utf8'));
p.version = '${FULL_VER}';
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
"
ok "package.json → ${FULL_VER}"

# 2. Copyright-Header in allen JS/HTML/CSS-Dateien
info "Copyright-Header in Quelldateien..."
COUNT=0
while IFS= read -r -d '' file; do
  if grep -q "ISMS Builder V ${OLD_SHORT}" "$file" 2>/dev/null; then
    sed -i "s/ISMS Builder V ${OLD_SHORT}/ISMS Builder V ${NEW_VERSION}/g" "$file"
    COUNT=$((COUNT + 1))
  fi
done < <(find server ui -type f \( -name "*.js" -o -name "*.html" -o -name "*.css" \) -print0 2>/dev/null)
ok "${COUNT} Quelldateien aktualisiert"

# 3. README.md
# NUR Zeile 1 (die Copyright-Kopfzeile) anfassen, nicht die ganze Datei —
# README.md enthaelt in der Roadmap-Tabelle historische Versionsangaben
# (z.B. "V 1.37.2.0" bei laengst abgeschlossenen Punkten, oder zufaellig genau
# die Vorversion bei einem gerade fertiggestellten Punkt). Ein fuzzy-Muster wie
# "V 1\.[0-9][0-9]*" traf frueher sogar "V 1.37" und haengte den Rest doppelt
# an; selbst ein exaktes Match auf OLD_FULL traf faelschlich die Roadmap-Zeile
# des zuletzt abgeschlossenen Punkts, weil deren Versionsangabe zufaellig
# gleich der alten Gesamtversion war. Nur Zeile 1 ist wirklich "die aktuelle
# Version", alles andere ist Historie und bleibt unangetastet.
info "README.md..."
sed -i "1s/V ${OLD_FULL}\b/V ${NEW_VERSION}/" README.md
sed -i "1s/version-${OLD_FULL}\b/version-${NEW_VERSION}/" README.md
ok "README.md (Zeile 1) → V ${NEW_VERSION}"

# 4. charts/isms-builder/Chart.yaml
# Keeps the Helm chart's version/appVersion in lockstep with package.json, so
# .github/workflows/release.yml's "helm-chart" job (which checks Chart.yaml's
# version against the pushed tag, mirroring the existing package.json check
# above) doesn't need a separate manual step.
if [[ -f charts/isms-builder/Chart.yaml ]]; then
  info "charts/isms-builder/Chart.yaml..."
  sed -i "s/^version: .*/version: ${FULL_VER}/" charts/isms-builder/Chart.yaml
  sed -i "s/^appVersion: .*/appVersion: \"${FULL_VER}\"/" charts/isms-builder/Chart.yaml
  ok "Chart.yaml → version/appVersion ${FULL_VER}"
fi

# 5. CLAUDE.md (Projektdoku)
if grep -q "V ${OLD_FULL}\b" CLAUDE.md 2>/dev/null; then
  sed -i "s/V ${OLD_FULL}\b/V ${NEW_VERSION}/g" CLAUDE.md
  ok "CLAUDE.md aktualisiert"
fi

echo ""
echo -e "${GREEN}Fertig! Version ist jetzt ${FULL_VER}${NC}"
echo ""
echo "Nächste Schritte:"
echo "  1. Änderungen prüfen: git diff"
echo "  2. npm test"
echo "  3. git add -A && git commit -m \"chore: bump version to ${FULL_VER}\""
echo "  4. Push + Tag: git tag v${FULL_VER} && git push origin main && git push origin v${FULL_VER}"
