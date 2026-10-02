if (window.opener && !window.opener.closed) {
    try {
        window.opener.connectPresentation(window);
    } catch {
        document.getElementById("displayMessage").textContent = "Return to the annotation page and reopen the video window.";
    }
}
