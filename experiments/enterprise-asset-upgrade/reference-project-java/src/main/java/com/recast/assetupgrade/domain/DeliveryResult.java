package com.recast.assetupgrade.domain;

public record DeliveryResult(boolean accepted, DeliveryStatus status, String detail) {
    public static DeliveryResult accepted(String detail) {
        return new DeliveryResult(true, DeliveryStatus.ACCEPTED, detail);
    }

    public static DeliveryResult rejected(String detail) {
        return new DeliveryResult(false, DeliveryStatus.REJECTED, detail);
    }

    public static DeliveryResult retryable(String detail) {
        return new DeliveryResult(false, DeliveryStatus.RETRYABLE, detail);
    }

    public static DeliveryResult duplicate(String detail) {
        return new DeliveryResult(true, DeliveryStatus.DUPLICATE, detail);
    }

    public static DeliveryResult quarantined(String detail) {
        return new DeliveryResult(false, DeliveryStatus.QUARANTINED, detail);
    }
}
