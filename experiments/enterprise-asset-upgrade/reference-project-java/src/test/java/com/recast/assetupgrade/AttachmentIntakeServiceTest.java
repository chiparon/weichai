package com.recast.assetupgrade;

import com.recast.assetupgrade.domain.*;
import org.junit.jupiter.api.Test;
import java.util.concurrent.CompletionException;
import static org.junit.jupiter.api.Assertions.*;

class AttachmentIntakeServiceTest {
    @Test void acceptsCleanPdfAndPersistsScannedState() {
        var app = ReferenceApplication.create();
        var result = app.attachmentIntake.accept("operator", ReferenceFixtures.pdf("tenant-a", "doc-1")).join();
        assertEquals(AttachmentState.SCANNED, result.state());
        assertEquals(1, app.scanner.scanCount());
        assertEquals(AttachmentState.SCANNED, app.attachments.find("tenant-a", "doc-1").orElseThrow().state());
        assertEquals("accepted", app.audit.all().get(0).status());
    }

    @Test void rejectsAttachmentFromAnotherTenant() {
        var app = ReferenceApplication.create();
        var failure = assertThrows(CompletionException.class,
                () -> app.attachmentIntake.accept("operator", ReferenceFixtures.pdf("tenant-b", "doc-2")).join());
        assertTrue(failure.getCause().getMessage().contains("cannot access"));
        assertEquals(0, app.attachments.size());
    }

    @Test void infectedScanMovesAttachmentToRejectedState() {
        var app = ReferenceApplication.create();
        app.scanner.infectNext();
        var failure = assertThrows(CompletionException.class,
                () -> app.attachmentIntake.accept("operator", ReferenceFixtures.pdf("tenant-a", "doc-3")).join());
        assertTrue(failure.getCause().getMessage().contains("signature blocked"));
        assertEquals(AttachmentState.REJECTED, app.attachments.find("tenant-a", "doc-3").orElseThrow().state());
    }

    @Test void scannerTimeoutIsVisibleToCaller() {
        var app = ReferenceApplication.create();
        app.scanner.timeoutNext();
        var failure = assertThrows(CompletionException.class,
                () -> app.attachmentIntake.accept("operator", ReferenceFixtures.pdf("tenant-a", "doc-4")).join());
        assertTrue(failure.getCause().getMessage().contains("timeout"));
        assertEquals(AttachmentState.REJECTED, app.attachments.find("tenant-a", "doc-4").orElseThrow().state());
    }

    @Test void unsafeFileNameDoesNotReachScanner() {
        var app = ReferenceApplication.create();
        var input = new AttachmentInput("doc-5", "tenant-a", "../secret.pdf", "application/pdf", "%PDF-".getBytes(), AttachmentState.SCANNED);
        assertThrows(CompletionException.class, () -> app.attachmentIntake.accept("operator", input).join());
        assertEquals(0, app.scanner.scanCount());
        assertEquals(0, app.attachments.size());
    }

    @Test void unsupportedMimeDoesNotReachScanner() {
        var app = ReferenceApplication.create();
        var input = new AttachmentInput("doc-6", "tenant-a", "doc.exe", "application/x-msdownload", "MZ".getBytes(), AttachmentState.SCANNED);
        assertThrows(CompletionException.class, () -> app.attachmentIntake.accept("operator", input).join());
        assertEquals(0, app.scanner.scanCount());
    }

    @Test void emptyContentIsRejected() {
        var app = ReferenceApplication.create();
        var input = new AttachmentInput("doc-7", "tenant-a", "doc.pdf", "application/pdf", new byte[0], AttachmentState.SCANNED);
        assertThrows(CompletionException.class, () -> app.attachmentIntake.accept("operator", input).join());
        assertEquals(0, app.attachments.size());
    }

    @Test void scanWarningIsAllowedBeforeScanner() {
        var app = ReferenceApplication.create();
        var result = app.attachmentIntake.accept("operator", ReferenceFixtures.text("tenant-a", "doc-8", AttachmentState.RECEIVED)).join();
        assertEquals(AttachmentState.SCANNED, result.state());
        assertEquals(1, app.scanner.scanCount());
    }
}
