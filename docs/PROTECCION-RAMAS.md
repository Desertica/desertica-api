# Protección de ramas

Ramas que existen y se protegen: `main`, `staging` y `develop`. (`deploy` y las ramas de trabajo `feat/*`, `claude/*`, `chore/*` no se protegen.)

## Antes de empezar (una sola vez)

1. Copia `docs/pipelines/ci.yml` a `.github/workflows/ci.yml` (reemplaza el que hay) y haz commit.
2. Abre un PR cualquiera para que el CI corra al menos una vez: GitHub solo deja elegir checks que ya se ejecutaron en los últimos 7 días.
3. Gitleaks en una organización exige licencia gratuita: pídela en <https://gitleaks.io>, y guárdala en **Settings → Secrets and variables → Actions → New repository secret** con nombre `GITLEAKS_LICENSE`.
4. CodeQL: si en **Settings → Code security → Code scanning** tienes activado "Default setup", desactívalo (choca con el job `codeql`).

## Crear la regla (repite para `develop`, `staging` y `main`)

1. En el repo, **Settings → Branches → Add branch ruleset** (o **Add classic branch protection rule**; los pasos son equivalentes).
2. Nombre del ruleset: `proteger-develop` (luego `proteger-staging`, `proteger-main`). **Enforcement status: Active**.
3. En **Target branches → Add target → Include by pattern**, escribe el nombre exacto: `develop`.
4. Marca estas opciones:
   - **Restrict deletions** y **Block force pushes**.
   - **Require a pull request before merging**, con **Required approvals: 1**, y marca **Dismiss stale pull request approvals when new commits are pushed**.
   - **Require status checks to pass**, marca **Require branches to be up to date before merging**, pulsa **Add checks** y añade exactamente estos nombres:

     | Check | Qué comprueba |
     | --- | --- |
     | `test` | lint, pruebas, build, migraciones sin drift y e2e |
     | `openapi` | validez de `openapi/*.yaml` |
     | `secrets` | gitleaks, sin secretos en el historial |
     | `codeql` | análisis estático de seguridad |

5. **Create** / **Save changes**.

## El check `audit`

`audit` (`npm audit --omit=dev --audit-level=high`) hoy **falla**: hay 6 vulnerabilidades altas y 1 crítica en dependencias de producción. En una prueba local, `npm audit fix` (sin `--force`) las resolvió, dejando solo 2 moderadas, con lint, pruebas, build y e2e en verde. Aplícalo en un PR aparte (`npm audit fix` y commit de `package-lock.json`). Hasta entonces no lo marques como obligatorio; cuando esté en verde, añádelo a la lista de checks de las tres ramas.

## Comprobar que funciona

El CI corre en cada push a cualquier rama y en cada PR, sea cual sea su base. Abre un PR hacia `develop`: el botón **Merge** debe quedar bloqueado hasta que `test`, `openapi`, `secrets` y `codeql` estén en verde y haya 1 aprobación. Un push directo a `develop` debe ser rechazado.
