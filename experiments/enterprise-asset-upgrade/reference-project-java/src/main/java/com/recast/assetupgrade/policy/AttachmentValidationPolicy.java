package com.recast.assetupgrade.policy;

import com.recast.assetupgrade.domain.AttachmentInput;
import com.recast.assetupgrade.domain.ValidationIssue;
import com.recast.assetupgrade.port.AttachmentQuarantine;
import java.util.ArrayList;
import java.util.List;

public final class AttachmentValidationPolicy {
    private final AttachmentQuarantine quarantine;
    private final FilenamePolicy filenames;
    private final MimePolicy mime;
    private final QuotaPolicy quota;

    public AttachmentValidationPolicy(AttachmentQuarantine quarantine) {
        this(quarantine, new FilenamePolicy(), new MimePolicy(), QuotaPolicy.defaults());
    }

    public AttachmentValidationPolicy(AttachmentQuarantine quarantine, FilenamePolicy filenames,
                                      MimePolicy mime, QuotaPolicy quota) {
        this.quarantine = quarantine;
        this.filenames = filenames;
        this.mime = mime;
        this.quota = quota;
    }

    public List<ValidationIssue> evaluate(AttachmentInput attachment) {
        List<ValidationIssue> issues = new ArrayList<>();
        if (attachment == null) return ValidationIssue.one("missing", "attachment is required");
        if (attachment.content().length == 0) issues.add(ValidationIssue.error("empty", "attachment is empty"));
        if (!quota.attachmentFits(attachment)) issues.add(ValidationIssue.error("size", "attachment exceeds size limit"));
        if (!filenames.isSafe(attachment.fileName())) issues.add(ValidationIssue.error("filename", "unsafe file name"));
        if (!mime.supports(attachment.declaredContentType())) issues.add(ValidationIssue.error("mime", "unsupported content type"));
        if (!mime.matchesExtension(attachment.declaredContentType(), filenames.extension(attachment.fileName()))) {
            issues.add(ValidationIssue.warning("extension", "file extension does not match content type"));
        }
        if (!attachment.scanned()) issues.add(ValidationIssue.warning("scan", "attachment has not been scanned"));
        if (!quarantine.isSafe(attachment)) issues.add(ValidationIssue.error("signature", "content signature does not match declaration"));
        return List.copyOf(issues);
    }

    public boolean requiresQuarantine(List<ValidationIssue> issues) {
        return issues.stream().anyMatch(issue -> issue.code().equals("scan"))
                && issues.stream().noneMatch(ValidationIssue::blocksOperation);
    }
}
