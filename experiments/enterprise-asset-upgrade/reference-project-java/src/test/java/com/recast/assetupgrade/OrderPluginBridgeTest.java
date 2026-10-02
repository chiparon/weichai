package com.recast.assetupgrade;

import com.recast.assetupgrade.domain.*;
import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class OrderPluginBridgeTest {
    @Test void validOrderReservesAndCommits() {
        var app = ReferenceApplication.create();
        var result = app.orderBridge.submit(ReferenceFixtures.order("tenant-a", "ord-1")).join();
        assertTrue(result.accepted());
        assertEquals(OrderStatus.ACCEPTED, result.status());
        assertEquals(1, app.inventory.reservationCount());
        assertTrue(app.committer.committed("ord-1"));
    }

    @Test void duplicateOrderIsIdempotent() {
        var app = ReferenceApplication.create();
        var order = ReferenceFixtures.order("tenant-a", "ord-2");
        assertTrue(app.orderBridge.submit(order).join().accepted());
        var duplicate = app.orderBridge.submit(order).join();
        assertTrue(duplicate.accepted());
        assertEquals(1, app.committer.committedCount());
    }

    @Test void unauthorizedActorCannotSubmitOrder() {
        var app = ReferenceApplication.create();
        var order = new OrderRequest("ord-3", "tenant-a", "unknown", List.of(new OrderLine("sku", 1, 100)), "CNY");
        var result = app.orderBridge.submit(order).join();
        assertFalse(result.accepted());
        assertEquals(OrderStatus.REJECTED, result.status());
        assertEquals(0, app.inventory.reservationCount());
    }

    @Test void unavailableInventoryRejectsBeforeCommit() {
        var app = ReferenceApplication.create();
        app.inventory.markUnavailable("sku-1");
        var result = app.orderBridge.submit(ReferenceFixtures.order("tenant-a", "ord-4")).join();
        assertEquals(OrderStatus.REJECTED, result.status());
        assertEquals(0, app.committer.committedCount());
    }

    @Test void commitFailureReleasesReservationAndClaim() {
        var app = ReferenceApplication.create();
        app.committer.failNextCommit();
        var result = app.orderBridge.submit(ReferenceFixtures.order("tenant-a", "ord-5")).join();
        assertEquals(OrderStatus.ROLLED_BACK, result.status());
        assertEquals(0, app.inventory.reservationCount());
        assertEquals(0, app.committer.committedCount());
        assertFalse(app.idempotency.hasCompleted("tenant-a", "ord-5"));
    }

    @Test void duplicateSkuIsRejected() {
        var app = ReferenceApplication.create();
        var order = new OrderRequest("ord-6", "tenant-a", "operator",
                List.of(new OrderLine("same", 1, 100), new OrderLine("same", 2, 100)), "CNY");
        var result = app.orderBridge.submit(order).join();
        assertEquals(OrderStatus.REJECTED, result.status());
        assertTrue(result.detail().contains("duplicate"));
    }

    @Test void unsupportedCurrencyIsRejected() {
        var app = ReferenceApplication.create();
        var order = new OrderRequest("ord-7", "tenant-a", "operator", List.of(new OrderLine("sku", 1, 100)), "GBP");
        var result = app.orderBridge.submit(order).join();
        assertEquals(OrderStatus.REJECTED, result.status());
        assertTrue(result.detail().contains("currency"));
    }

    @Test void zeroPriceOrderIsRejected() {
        var app = ReferenceApplication.create();
        var order = new OrderRequest("ord-8", "tenant-a", "operator", List.of(new OrderLine("sku", 1, 0)), "CNY");
        var result = app.orderBridge.submit(order).join();
        assertEquals(OrderStatus.REJECTED, result.status());
        assertTrue(result.detail().contains("positive"));
    }
}
