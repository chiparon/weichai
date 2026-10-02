package com.recast.assetupgrade.domain;

public record OrderResult(boolean accepted, OrderStatus status, String reservationId, String detail) {
    public static OrderResult accepted(String reservationId) {
        return new OrderResult(true, OrderStatus.ACCEPTED, reservationId, null);
    }

    public static OrderResult rejected(String detail) {
        return new OrderResult(false, OrderStatus.REJECTED, null, detail);
    }

    public static OrderResult rolledBack(String detail) {
        return new OrderResult(false, OrderStatus.ROLLED_BACK, null, detail);
    }
}
