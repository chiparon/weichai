package com.example.assetupgrade.order;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

import com.example.assetupgrade.audit.AuditAction;
import com.example.assetupgrade.audit.AuditEntry;
import com.example.assetupgrade.audit.AuditStatus;
import com.example.assetupgrade.common.CommandMetadata;
import com.example.assetupgrade.common.CorrelationId;
import com.example.assetupgrade.common.ProblemCode;
import com.example.assetupgrade.common.ServiceProblem;
import com.example.assetupgrade.common.TenantId;
import com.example.assetupgrade.retry.IdempotencyKey;

/**
 * Skeleton seam for OrderLifecycleCoordinator.
 * This type defines an extension boundary; implementation policy belongs to the Agent.
 * Provider-specific behavior must remain behind the declared ports and adapters.
 */
public final class OrderLifecycleCoordinator implements OrderPluginBridge {
    private static final String SUBMIT_OPERATION = "order.submit";
    private static final int INITIAL_VERSION = 1;

    private final OrderValidator validator;
    private final com.example.assetupgrade.order.port.InventoryPort inventory;
    private final com.example.assetupgrade.order.port.OrderCommitPort committer;
    private final com.example.assetupgrade.order.port.ReservationLedgerPort ledger;
    private final com.example.assetupgrade.order.port.OrderRepository orders;
    private final com.example.assetupgrade.order.port.PluginRegistryPort plugins;
    private final com.example.assetupgrade.audit.AuditPort audit;
    private final com.example.assetupgrade.retry.IdempotencyPort idempotency;
    private final com.example.assetupgrade.persistence.TransactionPort transaction;

    public OrderLifecycleCoordinator() {
        this(null, null, null, null, null, null, null, null, null);
    }

    public OrderLifecycleCoordinator(
            OrderValidator validator,
            com.example.assetupgrade.order.port.InventoryPort inventory,
            com.example.assetupgrade.order.port.OrderCommitPort committer,
            com.example.assetupgrade.order.port.ReservationLedgerPort ledger,
            com.example.assetupgrade.order.port.OrderRepository orders,
            com.example.assetupgrade.order.port.PluginRegistryPort plugins,
            com.example.assetupgrade.audit.AuditPort audit,
            com.example.assetupgrade.retry.IdempotencyPort idempotency,
            com.example.assetupgrade.persistence.TransactionPort transaction) {
        this.validator = validator;
        this.inventory = inventory;
        this.committer = committer;
        this.ledger = ledger;
        this.orders = orders;
        this.plugins = plugins;
        this.audit = audit;
        this.idempotency = idempotency;
        this.transaction = transaction;
    }

    @Override
    public OrderResult submit(OrderCommand command) {
        if (command == null) {
            throw new IllegalArgumentException("Expected OrderCommand");
        }

        CommandMetadata metadata = command.metadata();
        TenantId tenantId = metadata != null ? metadata.tenantId() : null;
        OrderRequest request = command.order();
        String orderId = request != null ? request.orderId() : null;
        String pluginId = command.pluginId();

        List<String> sideEffects = new ArrayList<>();

        if (request == null) {
            return reject(metadata, tenantId, orderId, pluginId,
                    ProblemCode.INVALID_INPUT, "Order request is required", sideEffects);
        }

        IdempotencyKey key = tenantId != null && orderId != null
                ? new IdempotencyKey(tenantId, SUBMIT_OPERATION, orderId)
                : null;

        if (idempotency != null && key != null && idempotency.isCompleted(key)) {
            sideEffects.add("duplicate");
            return new OrderResult(true, OrderStatus.ACCEPTED, null, List.of(), List.copyOf(sideEffects));
        }

        if (plugins != null) {
            Optional<PluginDescriptor> descriptor = tenantId != null
                    ? plugins.find(tenantId, pluginId)
                    : Optional.empty();
            if (descriptor.isEmpty()) {
                return reject(metadata, tenantId, orderId, pluginId,
                        ProblemCode.NOT_FOUND, "Plugin not found: " + pluginId, sideEffects);
            }
            if (!descriptor.get().enabled()) {
                return reject(metadata, tenantId, orderId, pluginId,
                        ProblemCode.TENANT_DENIED, "Plugin disabled: " + pluginId, sideEffects);
            }
        }

        if (validator != null) {
            List<ServiceProblem> problems = validator.validate(request);
            if (problems != null && !problems.isEmpty()) {
                appendAudit(metadata, tenantId, orderId, AuditAction.ORDER_SUBMISSION,
                        AuditStatus.REJECTED);
                return new OrderResult(false, OrderStatus.REJECTED, null,
                        List.copyOf(problems), List.copyOf(sideEffects));
            }
        }

        String[] reservationId = new String[1];
        Supplier<OrderResult> work = () -> runLifecycle(
                metadata, tenantId, orderId, pluginId, request, key, reservationId, sideEffects);
        try {
            if (transaction != null) {
                return transaction.inTransaction(work);
            }
            return work.get();
        } catch (RuntimeException failure) {
            return rollback(metadata, tenantId, orderId, request, key,
                    reservationId[0], sideEffects, failure);
        }
    }

    /** Compatibility seam for early implementations; typed methods are preferred. */
    public Object execute(Object input) {
        if (input instanceof OrderCommand command) return submit(command);
        throw new IllegalArgumentException("Expected OrderCommand");
    }

    private OrderResult runLifecycle(
            CommandMetadata metadata,
            TenantId tenantId,
            String orderId,
            String pluginId,
            OrderRequest request,
            IdempotencyKey key,
            String[] reservationId,
            List<String> sideEffects) {
        Reservation reservation = inventory != null ? inventory.reserve(request) : null;
        if (reservation == null) {
            return reject(metadata, tenantId, orderId, pluginId,
                    ProblemCode.STORAGE_FAILURE, "Inventory reservation failed", sideEffects);
        }

        reservationId[0] = reservation.reservationId();
        sideEffects.add("reserved");

        if (ledger != null) {
            ledger.save(reservation);
        }

        if (committer != null) {
            committer.commit(request, reservation);
        }
        sideEffects.add("committed");

        long totalMinor = totalMinor(request);
        Instant now = Instant.now();
        if (orders != null) {
            orders.save(new OrderSnapshot(request, OrderStatus.ACCEPTED, reservation,
                    totalMinor, now, INITIAL_VERSION));
        }
        sideEffects.add("persisted");

        if (idempotency != null && key != null) {
            idempotency.tryMarkCompleted(key);
        }

        appendAudit(metadata, tenantId, orderId, AuditAction.ORDER_SUBMISSION,
                AuditStatus.ACCEPTED);
        return new OrderResult(true, OrderStatus.ACCEPTED, reservation.reservationId(),
                List.of(), List.copyOf(sideEffects));
    }

    private OrderResult rollback(
            CommandMetadata metadata,
            TenantId tenantId,
            String orderId,
            OrderRequest request,
            IdempotencyKey key,
            String reservationId,
            List<String> sideEffects,
            RuntimeException failure) {
        if (reservationId != null) {
            if (inventory != null) {
                safely(() -> inventory.release(tenantId, reservationId));
            }
            if (ledger != null) {
                safely(() -> ledger.release(tenantId, reservationId));
            }
            sideEffects.add("released");
        }

        if (orders != null && request != null) {
            Instant now = Instant.now();
            safely(() -> orders.save(new OrderSnapshot(request, OrderStatus.ROLLED_BACK, null,
                    totalMinor(request), now, INITIAL_VERSION)));
            sideEffects.add("rollback-snapshot");
        }

        if (idempotency != null && key != null) {
            safely(() -> idempotency.remove(key));
            sideEffects.add("idempotency-cleared");
        }

        ServiceProblem problem = new ServiceProblem(
                mapFailure(failure), describe(failure), orderId, Map.of());
        appendAudit(metadata, tenantId, orderId, AuditAction.ORDER_SUBMISSION,
                AuditStatus.ROLLED_BACK);
        return new OrderResult(false, OrderStatus.ROLLED_BACK, reservationId,
                List.of(problem), List.copyOf(sideEffects));
    }

    private OrderResult reject(
            CommandMetadata metadata,
            TenantId tenantId,
            String orderId,
            String pluginId,
            ProblemCode code,
            String message,
            List<String> sideEffects) {
        String subjectId = orderId != null ? orderId : pluginId;
        ServiceProblem problem = new ServiceProblem(code, message, subjectId, Map.of());
        appendAudit(metadata, tenantId, orderId, AuditAction.ORDER_SUBMISSION,
                AuditStatus.REJECTED);
        return new OrderResult(false, OrderStatus.REJECTED, null,
                List.of(problem), List.copyOf(sideEffects));
    }

    private void appendAudit(
            CommandMetadata metadata,
            TenantId tenantId,
            String orderId,
            AuditAction action,
            AuditStatus status) {
        if (audit == null) {
            return;
        }
        CorrelationId correlationId = metadata != null ? metadata.correlationId() : null;
        Instant occurredAt = metadata != null && metadata.receivedAt() != null
                ? metadata.receivedAt()
                : Instant.now();
        Map<String, String> details = new LinkedHashMap<>();
        details.put("operation", SUBMIT_OPERATION);
        if (orderId != null) {
            details.put("orderId", orderId);
        }
        audit.append(new AuditEntry(tenantId, orderId, action, status,
                correlationId, occurredAt, details));
    }

    private static long totalMinor(OrderRequest request) {
        long total = 0L;
        if (request != null && request.lines() != null) {
            for (OrderLine line : request.lines()) {
                if (line != null) {
                    total += (long) line.quantity() * line.unitPriceMinor();
                }
            }
        }
        return total;
    }

    private static String describe(RuntimeException failure) {
        String message = failure.getMessage();
        return message != null && !message.isBlank()
                ? message
                : failure.getClass().getSimpleName();
    }

    private static ProblemCode mapFailure(RuntimeException failure) {
        String text = (failure.getClass().getSimpleName() + " "
                + String.valueOf(failure.getMessage())).toLowerCase(Locale.ROOT);
        if (text.contains("storage") || text.contains("persist")
                || text.contains("repository") || text.contains("ledger")) {
            return ProblemCode.STORAGE_FAILURE;
        }
        if (text.contains("transport") || text.contains("timeout")
                || text.contains("connect") || text.contains("socket")) {
            return ProblemCode.TRANSPORT_FAILURE;
        }
        return ProblemCode.RETRYABLE;
    }

    private static void safely(Runnable action) {
        try {
            action.run();
        } catch (RuntimeException ignored) {
            // Compensating action is best-effort; the primary failure is reported by the caller.
        }
    }
}
