{{/*
Expand the name of the chart.
*/}}
{{- define "isms-builder.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "isms-builder.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "isms-builder.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "isms-builder.labels" -}}
helm.sh/chart: {{ include "isms-builder.chart" . }}
{{ include "isms-builder.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "isms-builder.selectorLabels" -}}
app.kubernetes.io/name: {{ include "isms-builder.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "isms-builder.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "isms-builder.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
── Validation guards ────────────────────────────────────────────────────────
Fail fast with a clear message instead of deploying a configuration that is
silently unsafe or contradictory.
*/}}
{{- define "isms-builder.validate" -}}
{{- if and (gt (int .Values.replicaCount) 1) (or (eq .Values.storageBackend "json") (eq .Values.storageBackend "sqlite")) }}
{{- fail (printf "replicaCount > 1 requires storageBackend \"postgres\" or \"mariadb\" — %q is file-based with no cross-pod locking (see server/rbacStore.js and server/ai/embeddingStore.js for why this matters)." .Values.storageBackend) }}
{{- end }}
{{- if and .Values.postgresql.enabled (ne .Values.storageBackend "postgres") }}
{{- fail (printf "postgresql.enabled: true requires storageBackend: postgres (got %q). Either set storageBackend: postgres, or disable the bundled database and point database.external.* at your own." .Values.storageBackend) }}
{{- end }}
{{- $needsExternalDb := or (eq .Values.storageBackend "postgres") (eq .Values.storageBackend "mariadb") }}
{{- if and (not .Values.postgresql.enabled) $needsExternalDb (not .Values.database.external.host) }}
{{- fail "postgresql.enabled: false requires database.external.host to be set (or storageBackend: json/sqlite, which need no external database)." }}
{{- end }}
{{- if and (not .Values.postgresql.enabled) $needsExternalDb (not .Values.database.external.existingSecret) }}
{{- fail "postgresql.enabled: false with storageBackend postgres/mariadb requires database.external.existingSecret to be set (must contain key DB_PASS)." }}
{{- end }}
{{- if and .Values.ingress.tls.enabled .Values.tls.inPod.enabled }}
{{- fail "ingress.tls.enabled and tls.inPod.enabled are mutually exclusive — TLS is terminated either at the Ingress or in the pod, not both." }}
{{- end }}
{{- if and .Values.ingress.enabled (not .Values.ingress.host) }}
{{- fail "ingress.enabled: true requires ingress.host to be set." }}
{{- end }}
{{- end }}

{{/*
── Database connection helpers ──────────────────────────────────────────────
Resolve host/port/name/user/secret depending on whether the bundled
postgres subchart or an external database is in use.
*/}}
{{- define "isms-builder.dbHost" -}}
{{- if .Values.postgresql.enabled -}}
{{- /* The dependency is aliased "postgresql" in Chart.yaml, which the
   subchart's own fullname template picks up as its .Chart.Name — verified
   by rendering: the Service actually comes out as "<release>-postgresql". */ -}}
{{- printf "%s-postgresql" .Release.Name -}}
{{- else -}}
{{- .Values.database.external.host -}}
{{- end -}}
{{- end }}

{{- define "isms-builder.dbPort" -}}
{{- if .Values.postgresql.enabled -}}
5432
{{- else -}}
{{- .Values.database.external.port | default 5432 -}}
{{- end -}}
{{- end }}

{{- define "isms-builder.dbName" -}}
{{- if .Values.postgresql.enabled -}}
{{- .Values.postgresql.userDatabase.name.value -}}
{{- else -}}
{{- .Values.database.external.name -}}
{{- end -}}
{{- end }}

{{- define "isms-builder.dbUser" -}}
{{- if .Values.postgresql.enabled -}}
{{- .Values.postgresql.userDatabase.user.value -}}
{{- else -}}
{{- .Values.database.external.user -}}
{{- end -}}
{{- end }}

{{- define "isms-builder.dbSecretName" -}}
{{- if .Values.postgresql.enabled -}}
{{- .Values.postgresql.userDatabase.existingSecret -}}
{{- else -}}
{{- .Values.database.external.existingSecret -}}
{{- end -}}
{{- end }}

{{- define "isms-builder.dbSecretPasswordKey" -}}
{{- if .Values.postgresql.enabled -}}
USERDB_PASSWORD
{{- else -}}
DB_PASS
{{- end -}}
{{- end }}

{{- define "isms-builder.jwtSecretName" -}}
{{- if .Values.auth.jwtSecret.existingSecret -}}
{{- .Values.auth.jwtSecret.existingSecret -}}
{{- else -}}
{{- printf "%s-jwt" (include "isms-builder.fullname" .) -}}
{{- end -}}
{{- end }}
