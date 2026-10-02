package com.recast.assetupgrade.domain;

public record ReservationResult(boolean reserved, String reservationId, String detail) {
    public static ReservationResult success(String id) {
        return new ReservationResult(true, id, null);
    }

    public static ReservationResult failure(String detail) {
        return new ReservationResult(false, null, detail);
    }
}
