package com.recast.assetupgrade.port;

import com.recast.assetupgrade.domain.AttachmentInput;
import com.recast.assetupgrade.domain.AttachmentScanResult;
import java.util.concurrent.CompletableFuture;

public interface AttachmentScanner {
    CompletableFuture<AttachmentScanResult> scan(AttachmentInput attachment);
}
