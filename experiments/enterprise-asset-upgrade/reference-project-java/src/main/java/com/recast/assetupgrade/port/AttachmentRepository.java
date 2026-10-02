package com.recast.assetupgrade.port;

import com.recast.assetupgrade.domain.AttachmentInput;
import java.util.Optional;

public interface AttachmentRepository {
    Optional<AttachmentInput> find(String tenantId, String attachmentId);
    void save(AttachmentInput attachment);
    void release(String tenantId, String attachmentId);
}
