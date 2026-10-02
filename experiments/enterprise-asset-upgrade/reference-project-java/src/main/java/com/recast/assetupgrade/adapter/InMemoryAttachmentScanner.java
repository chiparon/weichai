package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.domain.AttachmentInput;
import com.recast.assetupgrade.domain.AttachmentScanResult;
import com.recast.assetupgrade.port.AttachmentScanner;
import java.time.Instant;
import java.util.concurrent.CompletableFuture;

public final class InMemoryAttachmentScanner implements AttachmentScanner {
    private boolean timeoutNext;
    private boolean infectNext;
    private int scans;

    public synchronized void timeoutNext() { timeoutNext = true; }
    public synchronized void infectNext() { infectNext = true; }
    public synchronized int scanCount() { return scans; }

    @Override public synchronized CompletableFuture<AttachmentScanResult> scan(AttachmentInput attachment) {
        scans++;
        if (timeoutNext) {
            timeoutNext = false;
            return CompletableFuture.completedFuture(new AttachmentScanResult(
                    attachment.attachmentId(), AttachmentScanResult.ScanVerdict.TIMEOUT, "memory-av", Instant.now(), "scanner timeout"));
        }
        if (infectNext) {
            infectNext = false;
            return CompletableFuture.completedFuture(new AttachmentScanResult(
                    attachment.attachmentId(), AttachmentScanResult.ScanVerdict.INFECTED, "memory-av", Instant.now(), "signature blocked"));
        }
        return CompletableFuture.completedFuture(new AttachmentScanResult(
                attachment.attachmentId(), AttachmentScanResult.ScanVerdict.CLEAN, "memory-av", Instant.now(), "clean"));
    }
}
