function activeStudySteps(settings) {
    return [0, ...(settings.surprise ? [1] : []), ...(settings.attention ? [2] : [])];
}

function nextStudyStep(settings, current) {
    return activeStudySteps(settings).find(step => step > current) ?? null;
}
