package com.recast.assetupgrade.application;

import com.recast.assetupgrade.domain.OperationContext;
import com.recast.assetupgrade.domain.ValidationIssue;
import com.recast.assetupgrade.port.TenantAuthorizer;
import com.recast.assetupgrade.policy.TenantPolicy;
import java.util.List;
import java.util.Map;

public final class TenantBoundaryService {
    private final TenantPolicy policy;
    public TenantBoundaryService(TenantAuthorizer authorizer) { this.policy = new TenantPolicy(authorizer); }

    public List<ValidationIssue> check(OperationContext context) {
        String error = policy.validate(context.tenantId(), context.actorId(), context.operation());
        return error == null ? List.of() : List.of(ValidationIssue.error("authorization", error));
    }

    public OperationContext context(String tenantId, String actorId, String operation, String correlationId) {
        return new OperationContext(tenantId, actorId, operation, correlationId, Map.of("source", "reference"));
    }
}
