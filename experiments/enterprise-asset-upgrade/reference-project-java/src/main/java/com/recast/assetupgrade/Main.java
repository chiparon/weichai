package com.recast.assetupgrade;

public final class Main {
    private Main() { }

    public static void main(String[] args) {
        ReferenceApplication application = ReferenceApplication.create();
        System.out.println("asset-upgrade-reference ready: "
                + application.health.check("tenant-a").status("clock"));
    }
}
