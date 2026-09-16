/**
 * False-positive control. This file is deliberately correct and must produce
 * no findings at all. A rules engine that fires here is worse than no rules
 * engine, because people switch off checkers that cry wolf.
 */
import { useQuery } from "@tanstack/react-query";

interface Props {
  userId: string;
  onSelect: (id: string) => void;
}

export function UserCard({ userId, onSelect }: Props) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["user", userId],
    queryFn: () => fetch(`/api/users/${userId}`).then((r) => r.json()),
  });

  if (isLoading) return <div className="skeleton" />;
  if (error) return <p role="alert">Could not load this user.</p>;
  if (!data) return <p>No such user.</p>;

  return (
    <button type="button" onClick={() => onSelect(userId)}>
      {data.name}
    </button>
  );
}
