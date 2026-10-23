# UptimeFlare: plan de mejoras

Plan preparado con GPT-6.1 Sol para `da4a9766a40652b5817699eef93fcb3b723dd3f7` y ejecutado con Luna Max. El alcance son los ocho problemas detectados en la revisión.

## Límites

- Preservar los cambios preexistentes en `apps/worker/package.json`, `apps/worker/src/domain/scheduler.snapshot.integration.test.ts` y `apps/worker/src/routes/public.ts`.
- Mantener los contratos JSON, las rutas, la configuración y las migraciones SQL productivas. No añadir dependencias.
- No hacer commit, push ni despliegue.
- Cambiar solo los archivos enumerados en las tareas y sus pruebas relacionadas.

## Orden de implementación

### Task 1 — Cubrir la migración `0006_snapshot_state.sql`

**Archivo:** `.github/scripts/d1-migrations.test.mjs`

- Añadir `0006_snapshot_state.sql` a la secuencia de migraciones y comprobar la tabla `snapshot_state` y sus columnas `id`, `updated_at` y `payload_json`.
- Hacer explícita la frontera de actualización anterior a `0005_daily_rollups_and_incident_impact.sql`; después aplicar `0005` y `0006` para comprobar el upgrade completo y conservar la prueba del backfill.
- Comprobar lectura/escritura mínima de `snapshot_state` y que volver a ejecutar las migraciones no altera el historial ni los datos.

**Aceptación:** `node --test .github/scripts/d1-migrations.test.mjs` cubre instalación desde cero, upgrade y repetición idempotente.

### Task 2 — Construir los assets web en el job de despliegue

**Archivos:** `.github/workflows/deploy.yml`, `.github/scripts/deploy-workflow.test.mjs`, `docs/deployment.md`

- Ejecutar `npm run build --workspace @pulseflare/web` en `deploy`, después de `npm ci` y antes de `wrangler deploy`, para crear `apps/web/dist` en el runner que lo necesita.
- Extender la prueba de workflow para comprobar el orden dentro del job `deploy`, no solo que exista un build en cualquier job.
- Corregir la documentación que atribuye el build al job `verify`.

**Aceptación:** la prueba del workflow y `npm run build --workspace @pulseflare/web` pasan.

### Task 3 — Guardar apertura de incidencia y notificación en una operación atómica

**Archivos:** `apps/worker/src/domain/scheduler.ts`, `apps/worker/src/domain/notification-engine.ts`, pruebas de ambos módulos y de ciclo de vida, `apps/worker/src/testing/sqlite-d1.ts`.

- Añadir las escrituras del outbox de apertura al mismo `database.batch` que persiste la incidencia; mantener la supresión durante mantenimiento y quitar el batch separado de apertura.
- Respetar `ON CONFLICT DO NOTHING`: el outbox y `payload_json.incidentId` deben referenciar la incidencia realmente abierta para el servicio, incluso cuando otra ejecución la haya creado primero.
- Conservar deduplicación, resolución y forma del webhook.
- Representar la semántica transaccional de D1 en el adaptador SQLite de pruebas para demostrar que un fallo en outbox no deja una incidencia parcial.

**Aceptación:** pruebas de apertura normal, conflicto concurrente, rollback del batch, mantenimiento, resolución y deduplicación pasan; columna `incident_id` y payload comparten el ID persistido.

### Task 4 — Calcular health a partir de ejecuciones completadas

**Archivos:** `apps/worker/src/repositories/d1.ts`, `apps/worker/src/routes/public.ts`, `apps/worker/src/domain/scheduler.ts` y pruebas relacionadas.

- Renombrar el helper como `getLatestCompletedSchedulerRun` y filtrar `succeeded`/`failed`; actualizar su único consumidor productivo.
- Health devuelve 200 si la última ejecución completada está dentro del umbral y tuvo éxito; una ejecución en curso no desplaza un éxito reciente, y un fallo completado más reciente devuelve 503.
- Usar la hora real de finalización al llamar a `finishSchedulerRun`, manteniendo `checkedAt` para resultados y snapshot.
- Mantener la forma JSON de health.

**Aceptación:** pruebas para ejecución en curso, fallo reciente, éxito caducado, ausencia de ejecución y hora final posterior a la inicial.

### Task 5 — Reutilizar la resolución materializada en `/api/public/services`

**Archivos:** `apps/worker/src/routes/public.ts`, `apps/worker/src/routes/public.test.ts`.

- Extraer y reutilizar entre `/snapshot` y `/services` el resolver de servicios materializados, incluida la caducidad por servicio, cobertura de IDs, metadatos de configuración y freshness.
- Rechazar también snapshots materializados que pertenezcan a otro día UTC, aunque su edad siga dentro del margen de diez minutos.
- Mantener `/services` como `{ services }` y dejar `buildRuntimeServicesPayload` como ruta de cálculo sin materialización para que el scheduler no entre en recursión.
- Conservar íntegros los cambios locales existentes en `public.ts` relacionados con estados, metadatos y freshness.

**Aceptación:** con snapshot fresco `/services` no consulta rollups diarios; caducidad, cobertura incompleta, retirada de IDs y fallback mantienen semántica coherente entre rutas.

### Task 6 — Retirar el estado verde cuando los datos estén caducados

**Archivos:** `apps/web/src/components/HeroStatus.tsx`, `apps/web/src/App.test.tsx`.

- Calcular freshness antes del titular y la señal; si los datos están caducados o la carga falla, el estado efectivo no debe afirmar que todo está operativo.
- Para datos caducados mostrar un titular de antigüedad y pedir resultados nuevos; conservar fecha, contador, refresh y polling.

**Aceptación:** un snapshot operativo caducado no muestra estado verde; uno fresco sigue verde y el error mantiene su presentación actual.

### Task 7 — Aclarar que el estado regional resume comprobaciones diarias UTC

**Archivos:** `apps/web/src/components/ServiceGroupList.tsx`, `apps/web/src/App.test.tsx`.

- Etiquetar el bucket regional usando el último día de `historyDays`: mostrar `Regional checks today (UTC)` si coincide con el día UTC actual y la fecha real si se conservan datos de un día anterior.
- Actualizar esa etiqueta al llegar la medianoche UTC incluso si las props del componente memoizado no cambian; explicar que los colores resumen el día etiquetado y que el uptime usa el historial mostrado.
- Mantener el bucket diario, los colores y los porcentajes; no añadir estado regional persistente.

**Aceptación:** la prueba regional verifica el nuevo rótulo y conserva valores y estados existentes.

### Task 8 — Alinear la documentación de arquitectura

**Archivo:** `docs/architecture.md`.

- Eliminar referencias activas a `packages/core` y `@pulseflare/core`, que ya no existen; describir la construcción de summary y payloads públicos en `apps/worker/src/routes/public.ts` y el papel de `@pulseflare/schema`.
- Documentar la resolución materializada compartida, `snapshot_state`, health por última ejecución completada, apertura/outbox atómicos y el agregado regional diario UTC.
- Mantener intactos documentos históricos de planes y especificaciones.

**Aceptación:** no quedan referencias a `packages/core`/`@pulseflare/core` en arquitectura y los enlaces locales citados existen.

### Corrección de revisión — rollover UTC

**Archivos:** `apps/worker/src/routes/public.ts`, pruebas de rutas públicas, `apps/web/src/components/ServiceGroupList.tsx`, `apps/web/src/lib/utc-day.ts`, `apps/web/src/App.test.tsx`.

- Evitar servir como actual un snapshot generado el día UTC anterior; `/snapshot` y `/services` deben volver al cálculo de historial vigente.
- Mantener veraz la etiqueta regional para snapshots retenidos y recalcular “today” al cambio de día aun cuando el componente no reciba props nuevas.
- Limpiar el temporizador de cambio de día al desmontar el componente.

**Aceptación:** la regresión de 23:59 a 00:01 UTC verifica el fallback en ambas rutas; las pruebas web verifican etiquetas para días actual/anterior y el temporizador de medianoche, su repetición y limpieza.

## Verificación final

1. Ejecutar primero las pruebas enfocadas de migración, workflow, Worker y web afectadas.
2. Ejecutar `npm test`, `npm run build` y `npm run lint` si las pruebas enfocadas pasan.
3. Revisar `git diff --check`, el diff de esta tarea y el diff local preexistente para confirmar que sigue intacto.
4. Informar por separado de validación estructural y estado local. CI posterior será quien pruebe el workflow desplegado; sin despliegue no se afirmará verificación runtime ni visual.
