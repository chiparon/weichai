package com.recast.assetupgrade.domain;

import java.time.Instant;

public record AttachmentScanResult(
        String attachmentId,
        ScanVerdict verdict,
        String scanner,
        Instant scannedAt,
        String detail) {
    public AttachmentScanResult {
        if (attachmentId == null || attachmentId.isBlank()) throw new IllegalArgumentException("attachmentId is required");
        if (verdict == null) throw new NullPointerException("verdict");
        if (scanner == null || scanner.isBlank()) throw new IllegalArgumentException("scanner is required");
        if (scannedAt == null) throw new NullPointerException("scannedAt");
    }

    public boolean allowed() { return verdict == ScanVerdict.CLEAN; }

    public enum ScanVerdict { CLEAN, INFECTED, TIMEOUT, UNKNOWN }
}
