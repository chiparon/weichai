package com.recast.assetupgrade.port;

import java.time.Instant;

public interface Clock {
    Instant now();
}
