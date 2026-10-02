package com.recast.assetupgrade.policy;

import com.recast.assetupgrade.domain.AttachmentInput;
import com.recast.assetupgrade.port.AttachmentQuarantine;

public final class AttachmentPolicy {
    private static final int MAX_BYTES = 10 * 1024 * 1024;
    private final AttachmentQuarantine quarantine;

    public AttachmentPolicy(AttachmentQuarantine quarantine) {
        this.quarantine = quarantine;
    }

    public Validation validate(AttachmentInput attachment) {
        if (attachment == null) return Validation.reject("attachment is required");
        if (attachment.content().length == 0) return Validation.reject("attachment is empty");
        if (attachment.content().length > MAX_BYTES) return Validation.reject("attachment exceeds size limit");
        if (!quarantine.isSafeFileName(attachment.fileName())) return Validation.reject("unsafe file name");
        if (!quarantine.isSupportedType(attachment.declaredContentType())) return Validation.reject("unsupported content type");
        if (!attachment.scanned()) return Validation.quarantine("attachment has not been scanned");
        if (!quarantine.isSafe(attachment)) return Validation.reject("content signature does not match declaration");
        return Validation.accept();
    }

    public record Validation(boolean valid, boolean quarantined, String reason) {
        public static Validation accept() { return new Validation(true, false, null); }
        public static Validation reject(String reason) { return new Validation(false, false, reason); }
        public static Validation quarantine(String reason) { return new Validation(false, true, reason); }
    }
}
