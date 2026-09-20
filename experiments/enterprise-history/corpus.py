"""Model-authored synthetic enterprise code. No customer data or Apache code."""

REPOSITORIES = {
    "business-contracts": ("erp_contracts", "Shared tenant, money and evidence contracts"),
    "identity-access": ("erp_identity", "Dealer and supplier authorization"),
    "document-center": ("erp_documents", "Business attachments and quarantine"),
    "asset-registry": ("erp_assets", "Engine entitlement and maintenance records"),
    "finance-ledger": ("erp_finance", "Idempotent warranty and supplier postings"),
    "audit-trail": ("erp_audit", "Transactional audit outbox"),
    "case-services": ("erp_cases", "Warranty, supplier quality and maintenance cases"),
    "operations-portal": ("erp_portal", "Enterprise workflow composition"),
}

# Each key is a Python import path, not an evaluation label. Imports are real,
# executable dependencies and are the only edges used by the graph baseline.
SOURCES = {
"erp_contracts.models": '''
from dataclasses import dataclass

@dataclass(frozen=True)
class Principal:
    tenant: str
    roles: frozenset[str]

@dataclass(frozen=True)
class Asset:
    tenant: str
    serial: str
    commissioned_day: int
    warranty_days: int
    hours: int

@dataclass(frozen=True)
class Evidence:
    tenant: str
    digest: str
    media_type: str
    size: int
    scanned: bool

@dataclass(frozen=True)
class Money:
    minor: int
    currency: str = "CNY"

    def __post_init__(self):
        if type(self.minor) is not int or self.minor < 0:
            raise ValueError("money requires nonnegative integer minor units")
        if self.currency not in {"CNY", "USD"}:
            raise ValueError("unsupported currency")
''',
"erp_identity.policy": '''
from erp_contracts.models import Principal

def authorize(actor: Principal, tenant: str, role: str):
    """Require both tenant isolation and the business role."""
    if actor.tenant != tenant or role not in actor.roles:
        raise PermissionError("tenant or role denied")
''',
"erp_documents.upload": '''
import hashlib
from pathlib import PurePosixPath
from erp_contracts.models import Evidence, Principal
from erp_identity.policy import authorize

def receive_attachment(actor: Principal, tenant: str, filename: str,
                       payload: bytes, media_type: str, scanned: bool):
    """Upload a business attachment; unscanned content remains quarantined."""
    authorize(actor, tenant, "upload")
    if not filename or PurePosixPath(filename).name != filename or "\\\\" in filename or filename in {".", ".."}:
        raise ValueError("unsafe attachment name")
    if not payload or len(payload) > 1048576:
        raise ValueError("attachment size exceeds policy")
    signatures = {"application/pdf": b"%PDF-", "image/png": b"\\x89PNG\\r\\n\\x1a\\n"}
    if media_type not in signatures or not payload.startswith(signatures[media_type]):
        raise ValueError("content signature disagrees with media type")
    return Evidence(tenant, hashlib.sha256(payload).hexdigest(), media_type, len(payload), scanned)
''',
"erp_documents.release": '''
from erp_contracts.models import Evidence

def require_released(evidence: Evidence, tenant: str):
    """Only scanned attachments owned by this tenant can support approval."""
    if evidence.tenant != tenant:
        raise PermissionError("attachment belongs to another tenant")
    if not evidence.scanned:
        raise ValueError("attachment still in quarantine")
    return evidence.digest
''',
"erp_documents.legacy_upload": '''
def receive_attachment(filename, payload):
    """Archived v1 intranet upload API; no tenant or malware scan contract."""
    return {"filename": filename, "size": len(payload), "approved": True}
''',
"erp_assets.entitlement": '''
from erp_contracts.models import Asset

def require_warranty(asset: Asset, tenant: str, day: int):
    """Warranty includes its final day and excludes future commissioning."""
    if asset.tenant != tenant:
        raise PermissionError("asset belongs to another tenant")
    age = day - asset.commissioned_day
    if age < 0 or age > asset.warranty_days or asset.hours > 5000:
        raise ValueError("warranty entitlement expired")
    return asset.serial
''',
"erp_assets.maintenance": '''
from erp_contracts.models import Asset

def require_service_due(asset: Asset, tenant: str, last_service_hours: int):
    """Schedule engine maintenance after 500 operating hours, independent of warranty."""
    if asset.tenant != tenant:
        raise PermissionError("asset belongs to another tenant")
    if last_service_hours < 0 or last_service_hours > asset.hours:
        raise ValueError("invalid service meter")
    if asset.hours - last_service_hours < 500:
        raise ValueError("maintenance not due")
    return asset.serial
''',
"erp_assets.inventory": '''
def reserve_spare_parts(stock, sku, count):
    """Warehouse allocation is independent of warranty entitlement."""
    if count <= 0 or stock.get(sku, 0) < count:
        raise ValueError("insufficient stock")
    stock[sku] -= count
    return count
''',
"erp_finance.posting": '''
from erp_contracts.models import Money

def post_once(ledger: dict, tenant: str, case_id: str, amount: Money, kind: str):
    """Post integer minor units once per tenant, case and ledger purpose."""
    key = (tenant, kind, case_id)
    value = (amount.minor, amount.currency)
    if key in ledger and ledger[key] != value:
        raise ValueError("idempotency key reused with a different amount")
    ledger.setdefault(key, value)
    return key
''',
"erp_finance.supplier": '''
from erp_contracts.models import Money

def calculate_debit(unit_cost: Money, rejected: int, delivered: int):
    """Charge back only rejected units from a delivered supplier lot."""
    if type(rejected) is not int or type(delivered) is not int or not 0 < rejected <= delivered:
        raise ValueError("invalid rejected quantity")
    return Money(unit_cost.minor * rejected, unit_cost.currency)
''',
"erp_finance.legacy_posting": '''
def post_once(ledger, case_id, amount):
    """Archived v1 reimbursement API: global case key and floating yuan."""
    ledger[case_id] = round(float(amount), 2)
    return case_id
''',
"erp_finance.payroll": '''
def calculate_reimbursement(employee, travel_yuan):
    """Employee expense approval does not post dealer warranty compensation."""
    if travel_yuan < 0 or not employee:
        raise ValueError("invalid expense")
    return {"employee": employee, "approved_yuan": min(travel_yuan, 2000)}
''',
"erp_audit.outbox": '''
import hashlib
import json

def enqueue(events: dict, tenant: str, case_id: str, kind: str, digest: str):
    """Retain one business event per tenant and workflow for retried requests."""
    key = (tenant, kind, case_id)
    event = {"tenant": tenant, "case": case_id, "kind": kind, "evidence": digest}
    if key in events and events[key] != event:
        raise ValueError("event identity conflict")
    events.setdefault(key, event)
    return hashlib.sha256(json.dumps(event, sort_keys=True).encode()).hexdigest()
''',
"erp_audit.dispatch": '''
def dispatch_pending(events: dict, delivered: set, send):
    """Mark an outbox event delivered only after the transport acknowledges it."""
    for key, event in events.items():
        if key not in delivered:
            send(event)
            delivered.add(key)
    return len(delivered)
''',
"erp_cases.warranty": '''
from erp_identity.policy import authorize
from erp_documents.release import require_released
from erp_assets.entitlement import require_warranty
from erp_finance.posting import post_once
from erp_audit.outbox import enqueue

def settle_claim(actor, asset, evidence, day, case_id, amount, ledger, events):
    """Approve dealer warranty compensation with eligibility and attachment evidence."""
    authorize(actor, asset.tenant, "dealer")
    require_warranty(asset, actor.tenant, day)
    digest = require_released(evidence, actor.tenant)
    posting = post_once(ledger, actor.tenant, case_id, amount, "warranty")
    enqueue(events, actor.tenant, case_id, "warranty", digest)
    return posting
''',
"erp_cases.quality": '''
from erp_identity.policy import authorize
from erp_documents.release import require_released
from erp_finance.supplier import calculate_debit
from erp_finance.posting import post_once
from erp_audit.outbox import enqueue

def close_nonconformance(actor, tenant, evidence, case_id, unit_cost, rejected, delivered, ledger, events):
    """Close supplier quality nonconformance and debit rejected delivered units."""
    authorize(actor, tenant, "quality")
    digest = require_released(evidence, tenant)
    amount = calculate_debit(unit_cost, rejected, delivered)
    posting = post_once(ledger, tenant, case_id, amount, "supplier-debit")
    enqueue(events, tenant, case_id, "supplier-debit", digest)
    return posting
''',
"erp_cases.maintenance": '''
from erp_identity.policy import authorize
from erp_documents.release import require_released
from erp_assets.maintenance import require_service_due
from erp_audit.outbox import enqueue

def schedule_service(actor, asset, evidence, last_service_hours, case_id, events):
    """Open a maintenance work order at the meter threshold with signed evidence."""
    authorize(actor, asset.tenant, "technician")
    serial = require_service_due(asset, actor.tenant, last_service_hours)
    digest = require_released(evidence, actor.tenant)
    enqueue(events, actor.tenant, case_id, "maintenance", digest)
    return {"serial": serial, "case": case_id, "status": "scheduled"}
''',
"erp_cases.dashboard": '''
def summarize_cases(cases):
    """Reporting counts warranty, supplier and maintenance cases; it authorizes no posting."""
    result = {}
    for case in cases:
        result[case["kind"]] = result.get(case["kind"], 0) + 1
    return result
''',
"erp_portal.transaction": '''
from copy import deepcopy

def atomic_case(state, operation, *args):
    """Copy-on-write fixture transaction commits ledger and outbox together.

    This in-process simulation assumes serialized requests, not distributed ACID.
    """
    staged = deepcopy(state)
    result = operation(*args, staged["ledger"], staged["events"])
    state.clear()
    state.update(staged)
    return result
''',
"erp_portal.gateway": '''
from erp_cases.warranty import settle_claim
from erp_cases.quality import close_nonconformance
from erp_portal.transaction import atomic_case

def submit_warranty(state, actor, asset, evidence, day, case_id, amount):
    """Commit dealer reimbursement and audit publication as one unit."""
    return atomic_case(state, settle_claim, actor, asset, evidence, day, case_id, amount)

def submit_quality(state, actor, tenant, evidence, case_id, unit_cost, rejected, delivered):
    """Commit supplier debit and its quality evidence event together."""
    return atomic_case(state, close_nonconformance, actor, tenant, evidence, case_id, unit_cost, rejected, delivered)
''',
}

# Deliberate historical incompatibility; this is a synthetic release, not a
# recovered customer commit. Each repository can be materialized as a real git
# history with these two states by build.py --git-history.
RELEASE_ONE = {
    "erp_identity.policy": '''
def authorize(actor, tenant, role):
    """Intranet release one checks roles only."""
    if role not in actor.roles:
        raise PermissionError("role denied")
''',
    "erp_assets.entitlement": SOURCES["erp_assets.entitlement"].replace("age > asset.warranty_days", "age >= asset.warranty_days"),
}
