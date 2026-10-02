package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.domain.AttachmentInput;
import com.recast.assetupgrade.port.AttachmentQuarantine;
import java.util.HashSet;
import java.util.Set;

/** Fixture for testing content policy independently from the default signature checker. */
public final class ConfigurableAttachmentQuarantine implements AttachmentQuarantine {
    private final Set<String> blockedIds = new HashSet<>();
    private final Set<String> supportedTypes = new HashSet<>(Set.of("application/pdf", "text/plain", "application/octet-stream"));
    public void block(String attachmentId) { blockedIds.add(attachmentId); }
    public void allowType(String type) { supportedTypes.add(type); }
    public void removeType(String type) { supportedTypes.remove(type); }
    @Override public boolean isSafe(AttachmentInput attachment) { return !blockedIds.contains(attachment.attachmentId()); }
    @Override public boolean isSupportedType(String declaredContentType) { return supportedTypes.contains(declaredContentType); }
    @Override public boolean isSafeFileName(String fileName) { return fileName != null && !fileName.contains("..") && !fileName.contains("/") && !fileName.contains("\\"); }
}
