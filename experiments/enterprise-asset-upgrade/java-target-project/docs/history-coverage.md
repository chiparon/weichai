# Java target history coverage

The target combines heterogeneous enterprise assets rather than copying one
repository. Each row identifies a reusable design concept and the new boundary
where the Agent must adapt it.

| Target capability | History asset and upstream concept | Required adaptation |
|---|---|---|
| multipart intake, filename and content checks | [Apache Commons FileUpload](https://github.com/apache/commons-fileupload) — streaming multipart and file metadata | tenant-aware attachment ports, quarantine state, MIME/signature policy |
| tenant and actor authorization | [Keycloak](https://github.com/keycloak/keycloak) — realms, roles, policy decisions | operation-scoped tenant context and audit propagation |
| approval and workflow state | [Flowable](https://github.com/flowable/flowable-engine) — process definitions and state transitions | target event envelope, approved-state gate, duplicate-safe dispatch |
| routing and protocol bridges | [Apache Camel](https://github.com/apache/camel) — routes, processors, endpoint adapters | vendor-neutral route/transform/dispatcher ports |
| delayed retry and dead letters | [BullMQ](https://github.com/taskforcesh/bullmq) — attempts, backoff, queues | tenant-scoped retry record, idempotency key, dead-letter boundary |
| periodic reconciliation | [APScheduler](https://github.com/agronholm/apscheduler) — schedules, jobs, leases | due-window query, checkpoint, lease, and rerunnable orchestration |
| order and plugin boundaries | [nopCommerce](https://github.com/nopSolutions/nopCommerce) — order aggregates and plugin contracts | Java order aggregate, inventory ledger, transactional plugin bridge |

These are concept references only. The history checkout remains outside this project and no source file, path, or
generated dependency is exposed to the implementation Agent.
