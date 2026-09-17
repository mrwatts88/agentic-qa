export function Profile({ bio, website }: { bio: string; website: string }) {
  const next = new URLSearchParams(window.location.search).get("next");
  if (next) window.location.href = next;
  return (
    <div>
      <div dangerouslySetInnerHTML={{ __html: bio }} />
      <a href={website}>site</a>
    </div>
  );
}
