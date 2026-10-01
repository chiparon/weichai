"""Evaluator-only annotations. Never copy this file into a reference repository."""

TASKS = [
    ("attachment-intake", "dev", "Receive a dealer attachment with tenant authorization, filename safety, size and MIME signature checks; keep unscanned files quarantined.",
     ["erp_documents.upload"], ["erp_documents.upload", "erp_identity.policy", "erp_contracts.models"]),
    ("supplier-charge", "dev", "Calculate a supplier debit in integer minor units for rejected items, checking that the rejected quantity does not exceed delivery.",
     ["erp_finance.supplier"], ["erp_finance.supplier", "erp_contracts.models"]),
    ("outbox-delivery", "dev", "Retry audit event delivery after transport failure without marking failed sends as delivered.",
     ["erp_audit.dispatch"], ["erp_audit.dispatch"]),
    ("warranty-close", "test", "Approve a dealer engine warranty claim using ownership, inclusive warranty deadline and scanned attachments; post compensation once and retain its audit event.",
     ["erp_cases.warranty"], ["erp_cases.warranty", "erp_identity.policy", "erp_documents.release", "erp_assets.entitlement", "erp_finance.posting", "erp_audit.outbox"]),
    ("quality-close", "test", "Close supplier nonconformance using a released inspection attachment and quality role; debit only rejected delivered units and publish an audit event once.",
     ["erp_cases.quality"], ["erp_cases.quality", "erp_identity.policy", "erp_documents.release", "erp_finance.supplier", "erp_finance.posting", "erp_audit.outbox"]),
    ("maintenance-order", "test", "A technician opens a maintenance work order after 500 operating hours since service; require tenant ownership, released evidence and an audit event, without checking warranty coverage.",
     ["erp_cases.maintenance"], ["erp_cases.maintenance", "erp_identity.policy", "erp_assets.maintenance", "erp_documents.release", "erp_audit.outbox"]),
    ("atomic-warranty", "test", "Ensure a dealer reimbursement and its audit event commit together; an evidence conflict must leave both ledger and outbox unchanged.",
     ["erp_portal.gateway", "erp_portal.transaction"], ["erp_portal.gateway", "erp_portal.transaction", "erp_cases.warranty", "erp_finance.posting", "erp_audit.outbox"]),
    ("tenant-retry", "test", "Two tenants may reuse the same claim number. Retry a financial posting without double payment, but reject changed amounts for the same purpose and tenant.",
     ["erp_finance.posting"], ["erp_finance.posting", "erp_contracts.models"]),
    ("quarantine-release", "test", "Reject quarantined evidence and attachments owned by another tenant before business approval.",
     ["erp_documents.release"], ["erp_documents.release", "erp_contracts.models"]),
    ("warranty-boundary", "test", "Determine engine warranty entitlement on the last covered day, rejecting future commissioning dates, excessive hours and foreign tenant assets.",
     ["erp_assets.entitlement"], ["erp_assets.entitlement", "erp_contracts.models"]),
    ("quality-atomic", "test", "Roll back a supplier debit if its inspection audit event conflicts; publish the ledger posting and evidence event atomically.",
     ["erp_portal.gateway", "erp_portal.transaction"], ["erp_portal.gateway", "erp_portal.transaction", "erp_cases.quality", "erp_finance.posting", "erp_audit.outbox"]),
    ("maintenance-boundary", "test", "Check whether engine maintenance is due exactly 500 hours after the last service; reject a service meter greater than the current meter.",
     ["erp_assets.maintenance"], ["erp_assets.maintenance", "erp_contracts.models"]),
]

# Paired languages stay in the same task family and split. Report each language
# separately and do not count these as independent business scenarios.
CHINESE = {
    "attachment-intake": "接收经销商附件，校验租户权限、文件名、大小和真实文件类型，未扫描文件保持隔离。",
    "supplier-charge": "按不合格数量计算供应商扣款，金额以整数分计价，不合格数量不能超过到货数量。",
    "outbox-delivery": "审计事件发送失败后允许重试，只有传输确认成功才记录已送达。",
    "warranty-close": "经销商提交发动机质保索赔，校验资产归属、含最后一天的保修期限及已扫描附件，赔付款不能重复入账且保留审计事件。",
    "quality-close": "关闭供应商质量不合格单，需要质检权限和已放行的检验附件，仅对已交付的不合格件扣款，审计事件不可重复。",
    "maintenance-order": "技师在距离上次保养满500小时后开维保工单，校验租户资产归属和已放行凭证并记录审计，不依赖质保有效期。",
    "atomic-warranty": "经销商赔付与审计事件必须一起提交，凭证冲突时账本和发件箱都保持原状。",
    "tenant-retry": "不同租户可以使用相同索赔编号，付款重试不得重复入账，同一租户和用途下修改金额应报冲突。",
    "quarantine-release": "业务审批前拒绝仍在隔离区的附件，以及属于其他租户的凭证。",
    "warranty-boundary": "发动机保修最后一天仍可索赔，拒绝尚未投运、运行时数超限和其他租户的资产。",
    "quality-atomic": "供应商扣款与检验凭证审计必须原子提交，审计冲突时回滚扣款。",
    "maintenance-boundary": "距离上次保养恰好500小时应允许维保，上次保养表数高于当前表数时应拒绝。",
}
