package com.recast.assetupgrade.adapter;

import com.recast.assetupgrade.port.Clock;
import java.time.Instant;

public final class InMemoryClock implements Clock {
    private Instant current;

    public InMemoryClock(Instant initial) { this.current = initial; }
    @Override public Instant now() { return current; }
    public void advance(java.time.Duration duration) { current = current.plus(duration); }
    public void set(Instant next) { current = next; }
}
