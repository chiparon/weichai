package com.recast.assetupgrade.port;

import com.recast.assetupgrade.domain.AttachmentInput;

public interface AttachmentQuarantine {
    boolean isSafe(AttachmentInput attachment);
    boolean isSupportedType(String declaredContentType);
    boolean isSafeFileName(String fileName);
}
