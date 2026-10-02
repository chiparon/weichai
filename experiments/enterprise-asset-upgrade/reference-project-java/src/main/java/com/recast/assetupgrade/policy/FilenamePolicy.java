package com.recast.assetupgrade.policy;

import java.util.Set;

public final class FilenamePolicy {
    private static final Set<Character> CONTROL = Set.of('\u0000', '\n', '\r', '\t');

    public boolean isSafe(String fileName) {
        if (fileName == null || fileName.isBlank() || fileName.length() > 180) return false;
        if (fileName.contains("..") || fileName.contains("/") || fileName.contains("\\")) return false;
        return fileName.chars().noneMatch(value -> CONTROL.contains((char) value));
    }

    public String extension(String fileName) {
        if (!isSafe(fileName)) return "";
        int dot = fileName.lastIndexOf('.');
        return dot < 0 ? "" : fileName.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
    }

    public boolean isHidden(String fileName) {
        return isSafe(fileName) && fileName.startsWith(".");
    }
}
