package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.domain.AttachmentInput;
import com.recast.assetupgrade.domain.AttachmentState;
import com.recast.assetupgrade.port.AttachmentRepository;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

public final class InMemoryAttachmentRepository implements AttachmentRepository {
    private final Map<String, AttachmentInput> attachments = new HashMap<>();

    @Override public synchronized Optional<AttachmentInput> find(String tenantId, String attachmentId) {
        return Optional.ofNullable(attachments.get(key(tenantId, attachmentId)));
    }

    @Override public synchronized void save(AttachmentInput attachment) {
        attachments.put(key(attachment.tenantId(), attachment.attachmentId()), attachment);
    }

    @Override public synchronized void release(String tenantId, String attachmentId) {
        AttachmentInput current = attachments.get(key(tenantId, attachmentId));
        if (current != null) attachments.put(key(tenantId, attachmentId), new AttachmentInput(
                current.attachmentId(), current.tenantId(), current.fileName(), current.declaredContentType(),
                current.content(), AttachmentState.RELEASED));
    }

    public synchronized int size() { return attachments.size(); }
    public synchronized boolean isReleased(String tenantId, String attachmentId) {
        return find(tenantId, attachmentId).map(item -> item.state() == AttachmentState.RELEASED).orElse(false);
    }
    public synchronized Map<String, AttachmentInput> snapshot() { return Map.copyOf(attachments); }
    private String key(String tenantId, String attachmentId) { return tenantId + "\u0000" + attachmentId; }
}
