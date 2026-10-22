# Ramas y CI

| Rama | Para qué | Quién escribe en ella |
| --- | --- | --- |
| `main` | Base del repo. No se despliega. | Nadie (no se toca). |
| `develop` | Desarrollo. Aquí entra todo el trabajo. | PR desde `feat/*`, `fix/*`, `chore/*`. |
| `staging` | Pruebas. Es lo que se despliega en staging. | PR solo desde `develop`. |
| `prod` | Producción. Es lo que se despliega en producción. | PR solo desde `staging`. |

Las demás ramas son de trabajo: se borran al mezclar el PR.

## Qué comprueba el CI

Todo corre en cada PR hacia `develop`, `staging` o `prod` y en cada push a esas tres ramas. Checks obligatorios en las tres ramas:

| Workflow | Check | Qué comprueba |
| --- | --- | --- |
| `ci.yml` | `test`, `openapi`, `docker` | Lo propio del repo (ver `.github/workflows/ci.yml`) y que la imagen Docker construye. |
| `security.yml` | `secrets`, `audit`, `codeql` | Secretos en el historial (reglas en `.gitleaks.toml` si existe), dependencias de producción con vulnerabilidad alta y análisis estático. Corre también cada lunes. |
| `policy.yml` | `flow`, `commits`, `tracked-files` | Orden develop → staging → prod; commits sin `Co-Authored-By` ni autores bot (solo PR a `develop`); nada de `.env`, `.cursor/`, `.vscode/`, certificados ni basura del sistema en git. |

## Protección en GitHub

Ruleset activo en `develop`, `staging` y `prod`: PR obligatorio, checks de arriba obligatorios y al día, sin force-push ni borrado. No exige aprobaciones porque hoy hay una sola persona; añade `required_approving_review_count: 1` cuando haya más.

## Despliegue

Coolify construye desde Git: la app de staging sigue `staging` y la de producción sigue `prod` (Auto Deploy). El CI no despliega ni publica imágenes.
